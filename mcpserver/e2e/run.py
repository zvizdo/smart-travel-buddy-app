"""End-to-end smoke test for the Smart Travel Buddy MCP server.

Creates a temporary "Japan Golden Route" trip, exercises every one of the
19 MCP tools in a realistic sequence (build → mutate → version → delete),
then deletes the trip and verifies Firestore has no residue.

Run this after changes to mcpserver/, shared/shared/services/, or any tool
contract you want to validate end-to-end.

Usage:
    STB_MCP_API_KEY=stb_... python mcpserver/e2e/run.py
    STB_MCP_API_KEY=... STB_MCP_URL=http://localhost:8080/mcp \\
        python mcpserver/e2e/run.py --skip-firestore-verify

See mcpserver/e2e/README.md. Exits 0 on success, non-zero otherwise.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import traceback
from typing import Any

from fastmcp import Client


DEFAULT_URL = "http://localhost:8080/mcp"


S: dict[str, Any] = {
    "trip_id": None,
    "plan_id_main": None,
    "plan_id_draft": None,
    "nodes": {},
    "edges": {},
    "actions": {},
    "tools_called": set(),
    "issues": [],
}


def pretty(val: Any) -> str:
    return json.dumps(val, indent=2, default=str)


def _unwrap(result: Any) -> Any:
    """Extract the Python payload from a fastmcp CallToolResult.

    Prefers ``.data`` (deserialized Python); falls back to the first content
    block's text for markdown-returning tools (``get_trip_context``,
    ``list_actions``); returns ``{"error": ...}`` on tool error.
    """
    if getattr(result, "is_error", False):
        # content[0].text usually holds the error message
        msg = ""
        if result.content and hasattr(result.content[0], "text"):
            msg = result.content[0].text
        return {"error": msg or "tool returned is_error=True"}
    if result.data is not None:
        return result.data
    if result.content and hasattr(result.content[0], "text"):
        return {"text": result.content[0].text}
    return {}


async def _call(client: Client, name: str, args: dict) -> Any:
    return _unwrap(await client.call_tool(name, args))


def note(tool: str, r: Any, msg: str = "") -> None:
    S["tools_called"].add(tool)
    head = f"\n### {tool}" + (f"  — {msg}" if msg else "")
    print(head)
    print(pretty(r) if isinstance(r, (dict, list)) else str(r))
    if isinstance(r, dict) and "error" in r:
        S["issues"].append(f"{tool}: error → {r['error']}")


def issue(msg: str) -> None:
    S["issues"].append(msg)
    print(f"\n[ISSUE] {msg}")


def get_id(r: Any, *paths: str) -> str | None:
    if not isinstance(r, dict):
        return None
    for p in paths:
        cur: Any = r
        for part in p.split("."):
            if isinstance(cur, dict) and part in cur:
                cur = cur[part]
            else:
                cur = None
                break
        if isinstance(cur, str):
            return cur
    return None


async def run_scenario(client: Client) -> int:
    """Drive the full 19-tool scenario. Returns 0 on success, 1 on failure."""
    r = await _call(client, "get_trips", {})
    note("get_trips", r, "snapshot before")
    preserved = {t["id"] for t in r.get("trips", [])}
    print(f"\nPRESERVED (do-not-touch) trip IDs: {sorted(preserved)}\n")

    r = await _call(client, "create_trip", {"name": "E2E Smoke — Japan Golden Route"})
    note("create_trip", r)
    S["trip_id"] = get_id(r, "trip.id")
    S["plan_id_main"] = get_id(r, "plan.id")
    if not S["trip_id"] or not S["plan_id_main"]:
        issue("could not extract trip.id / plan.id from create_trip response")
        return 1
    tid = S["trip_id"]

    note("get_trip_plans", await _call(client, "get_trip_plans", {"trip_id": tid}))

    r = await _call(client, "find_places", {
        "query": "ramen shop Dotonbori",
        "lat": 34.6687, "lng": 135.5029, "radius_km": 2.0,
    })
    note("find_places", r, "ramen near Osaka")
    place_id_osaka = None
    place_name_osaka = None
    if isinstance(r, dict) and isinstance(r.get("places"), list) and r["places"]:
        place_id_osaka = r["places"][0].get("place_id")
        place_name_osaka = r["places"][0].get("name")
    if not place_id_osaka:
        issue("find_places returned no places — later add_action(type=place) may fail")

    spec = [
        ("Tokyo",     "city",  35.6812, 139.7671, "2026-05-10T09:00:00+09:00", "2026-05-11T09:00:00+09:00", 1440),
        ("Kyoto",     "city",  35.0116, 135.7681, "2026-05-11T12:00:00+09:00", "2026-05-12T09:00:00+09:00", 1260),
        ("Osaka",     "city",  34.6937, 135.5023, "2026-05-12T10:30:00+09:00", "2026-05-13T09:00:00+09:00", 1350),
        ("Nara",      "place", 34.6851, 135.8048, "2026-05-13T10:30:00+09:00", "2026-05-13T16:00:00+09:00", 330),
        ("Hiroshima", "city",  34.3853, 132.4553, "2026-05-14T12:00:00+09:00", "2026-05-15T09:00:00+09:00", 1260),
    ]
    for nm, ty, la, lg, arr, dep, dur in spec:
        r = await _call(client, "add_node", {
            "trip_id": tid, "name": nm, "type": ty, "lat": la, "lng": lg,
            "arrival_time": arr, "departure_time": dep, "duration_minutes": dur,
        })
        note("add_node", r, nm)
        nid = get_id(r, "node.id")
        if nid:
            S["nodes"][nm] = nid
        else:
            issue(f"add_node {nm}: no node.id")
    if len(S["nodes"]) < 5:
        issue(f"only {len(S['nodes'])}/5 nodes created — aborting")
        return 1

    for f, t, mode, ntxt in [
        ("Tokyo",   "Kyoto",     "transit", "Shinkansen Nozomi ~2h15m"),
        ("Kyoto",   "Osaka",     "transit", "JR Special Rapid 30min"),
        ("Osaka",   "Nara",      "drive",   "rental-car day trip"),
        ("Osaka",   "Hiroshima", "flight",  "direct flight"),
    ]:
        r = await _call(client, "add_edge", {
            "trip_id": tid,
            "from_node_id": S["nodes"][f], "to_node_id": S["nodes"][t],
            "travel_mode": mode, "notes": ntxt,
        })
        note("add_edge", r, f"{f} → {t} [{mode}]")
        eid = get_id(r, "edge.id")
        if eid:
            S["edges"][f"{f}->{t}"] = eid
        else:
            issue(f"add_edge {f}->{t}: no edge.id")

    note("get_trip_context",
         await _call(client, "get_trip_context", {"trip_id": tid}), "after build")

    note("update_node", await _call(client, "update_node", {
        "trip_id": tid, "node_id": S["nodes"]["Tokyo"],
        "departure_time": "2026-05-12T09:00:00+09:00", "duration_minutes": 2880,
    }), "Tokyo → 2 nights")
    note("update_node", await _call(client, "update_node", {
        "trip_id": tid, "node_id": S["nodes"]["Nara"], "name": "Nara Deer Park",
    }), "Nara rename")
    note("update_node", await _call(client, "update_node", {
        "trip_id": tid, "node_id": S["nodes"]["Osaka"],
        "lat": 34.6698, "lng": 135.5023,
    }), "Osaka nudge lat/lng")

    r = await _call(client, "add_action", {
        "trip_id": tid, "node_id": S["nodes"]["Tokyo"], "type": "todo",
        "content": "Book teamLab Planets tickets 2 weeks in advance",
    })
    note("add_action", r, "Tokyo todo")
    if (a := get_id(r, "action.id")):
        S["actions"]["tokyo_todo"] = a
    r = await _call(client, "add_action", {
        "trip_id": tid, "node_id": S["nodes"]["Kyoto"], "type": "note",
        "content": "Fushimi Inari best at sunrise — take JR to Inari Station.",
    })
    note("add_action", r, "Kyoto note")
    if (a := get_id(r, "action.id")):
        S["actions"]["kyoto_note"] = a
    if place_id_osaka:
        r = await _call(client, "add_action", {
            "trip_id": tid, "node_id": S["nodes"]["Osaka"], "type": "place",
            "content": "must-try ramen", "place_name": place_name_osaka or "Osaka Ramen",
            "place_id": place_id_osaka, "place_lat": 34.6687, "place_lng": 135.5029,
            "place_category": "restaurant",
        })
        note("add_action", r, f"Osaka place ({place_name_osaka!r})")

    note("list_actions", await _call(client, "list_actions", {
        "trip_id": tid, "node_id": S["nodes"]["Osaka"],
    }), "Osaka")

    if "kyoto_note" in S["actions"]:
        note("delete_action", await _call(client, "delete_action", {
            "trip_id": tid, "node_id": S["nodes"]["Kyoto"],
            "action_id": S["actions"]["kyoto_note"],
        }), "remove Kyoto note")

    note("find_flights", await _call(client, "find_flights", {
        "origin": "HND", "destination": "ITM",
        "date": "2026-05-12", "max_results": 3,
    }), "HND→ITM 2026-05-12")

    note("update_trip_settings", await _call(client, "update_trip_settings", {
        "trip_id": tid, "max_drive_hours_per_day": 6.0,
        "no_drive_window_start_hour": 22, "no_drive_window_end_hour": 6,
    }), "drive cap + night window")

    r = await _call(client, "create_plan", {
        "trip_id": tid, "name": "Alt — Skip Nara",
        "source_plan_id": S["plan_id_main"], "include_actions": True,
    })
    note("create_plan", r, "clone of main")
    S["plan_id_draft"] = get_id(r, "plan.id")
    if S["plan_id_draft"]:
        note("promote_plan", await _call(client, "promote_plan", {
            "trip_id": tid, "plan_id": S["plan_id_draft"],
        }), "draft → active")
        note("promote_plan", await _call(client, "promote_plan", {
            "trip_id": tid, "plan_id": S["plan_id_main"],
        }), "main → active again")
        note("delete_plan", await _call(client, "delete_plan", {
            "trip_id": tid, "plan_id": S["plan_id_draft"],
        }), "remove draft")

    if "Osaka->Nara" in S["edges"]:
        note("delete_edge", await _call(client, "delete_edge", {
            "trip_id": tid, "edge_id": S["edges"]["Osaka->Nara"],
        }), "Osaka→Nara")
    if "Nara" in S["nodes"]:
        note("delete_node", await _call(client, "delete_node", {
            "trip_id": tid, "node_id": S["nodes"]["Nara"],
        }), "Nara")

    note("get_trip_context",
         await _call(client, "get_trip_context", {"trip_id": tid}), "after mutations")

    note("delete_trip", await _call(client, "delete_trip", {"trip_id": tid}),
         "final cleanup")
    r = await _call(client, "get_trips", {})
    remaining = {t["id"] for t in r.get("trips", [])}
    if tid in remaining:
        issue(f"trip {tid} still listed after delete_trip")
    missing = preserved - remaining
    if missing:
        issue(f"preserved trips disappeared: {missing}")

    return 0 if not S["issues"] else 1


def verify_firestore_clean(trip_id: str) -> bool:
    """Check Firestore has no residue under trips/{trip_id} after teardown.

    Requires google-cloud-firestore + ADC. Lazy-imports so runs without a
    Firestore dep can still exercise the MCP flow.
    """
    try:
        from google.cloud import firestore
    except ImportError:
        print("[!] google-cloud-firestore not installed; skipping Firestore verify")
        return True

    project = os.environ.get("GOOGLE_CLOUD_PROJECT") or "as-dev-anze"
    db = firestore.Client(project=project)
    trip_ref = db.collection("trips").document(trip_id)

    if trip_ref.get().exists:
        print(f"[!] trips/{trip_id} doc still exists")
        return False

    residue: list[str] = []
    def walk(ref, label: str) -> None:
        for sub in ref.collections():
            docs = list(sub.stream())
            if docs:
                residue.append(f"{label}/{sub.id} → {[d.id for d in docs]}")
                for d in docs:
                    walk(d.reference, f"{label}/{sub.id}/{d.id}")

    walk(trip_ref, f"trips/{trip_id}")
    if residue:
        print(f"[!] Firestore residue under trips/{trip_id}:")
        for line in residue:
            print(f"    {line}")
        return False

    print(f"[✓] Firestore clean under trips/{trip_id}")
    return True


async def main_async(url: str, api_key: str, skip_firestore: bool) -> int:
    exit_code = 0
    try:
        async with Client(url, auth=api_key) as client:
            # ping first so connection errors surface with a clean message
            await client.ping()
            exit_code = await run_scenario(client)
    except Exception:
        traceback.print_exc()
        exit_code = 2

    if not skip_firestore and S["trip_id"]:
        if not verify_firestore_clean(S["trip_id"]):
            exit_code = exit_code or 3

    tools_called = sorted(S["tools_called"])
    print("\n" + "=" * 60)
    print(f"TOOLS CALLED ({len(tools_called)}/19): {tools_called}")
    print("=" * 60)
    print(f"ISSUES ({len(S['issues'])}):")
    for i, msg in enumerate(S["issues"], 1):
        print(f"  {i}. {msg}")
    print(f"\nResult: {'PASS' if exit_code == 0 else 'FAIL'} (exit {exit_code})")
    return exit_code


def main() -> int:
    parser = argparse.ArgumentParser(description="MCP server end-to-end smoke test.")
    parser.add_argument("--url", default=None,
                        help="MCP URL (default: env STB_MCP_URL or localhost:8080/mcp)")
    parser.add_argument("--api-key", default=None,
                        help="API key (default: env STB_MCP_API_KEY)")
    parser.add_argument("--skip-firestore-verify", action="store_true",
                        help="Don't check Firestore for residue after delete_trip.")
    args = parser.parse_args()

    url = args.url or os.environ.get("STB_MCP_URL") or DEFAULT_URL
    api_key = args.api_key or os.environ.get("STB_MCP_API_KEY")
    if not api_key:
        parser.error(
            "API key required. Pass --api-key or set STB_MCP_API_KEY. "
            "Create one at the web app: Profile → API Keys."
        )

    return asyncio.run(main_async(url, api_key, args.skip_firestore_verify))


if __name__ == "__main__":
    sys.exit(main())
