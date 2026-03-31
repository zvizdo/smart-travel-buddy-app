"""Short, agent-friendly ID generator for DAG entities.

Produces IDs like ``n_k3xd9mpq`` (type prefix + 8-char lowercase alphanumeric).
Much easier for LLMs to reproduce accurately than 36-char UUID4s.
"""

import secrets
import string

_ALPHABET = string.ascii_lowercase + string.digits  # 36 chars


def generate_id(prefix: str, length: int = 8) -> str:
    """Generate a short, typed ID for a Firestore document.

    Args:
        prefix: Entity type prefix (e.g. ``"n"`` for node, ``"e"`` for edge).
        length: Number of random characters (default 8, giving 36^8 ≈ 2.8T combinations).
    """
    suffix = "".join(secrets.choice(_ALPHABET) for _ in range(length))
    return f"{prefix}_{suffix}"


def node_id() -> str:
    return generate_id("n")


def edge_id() -> str:
    return generate_id("e")


def plan_id() -> str:
    return generate_id("p")


def trip_id() -> str:
    return generate_id("t")


def action_id() -> str:
    return generate_id("a")
