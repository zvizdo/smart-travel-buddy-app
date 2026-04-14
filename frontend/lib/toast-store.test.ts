import { describe, it, expect, beforeEach } from "vitest";
import { toastStore } from "./toast-store";

describe("toast-store", () => {
  beforeEach(() => {
    toastStore.reset();
  });

  it("accepts a plain string message", () => {
    const id = toastStore.show("Hello");
    const snap = toastStore.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].id).toBe(id);
    expect(snap[0].message).toBe("Hello");
    expect(snap[0].variant).toBe("default");
    expect(snap[0].duration).toBe(5000);
    expect(snap[0].action).toBeNull();
  });

  it("accepts an options object with variant, duration, action", () => {
    const onClick = () => {};
    const id = toastStore.show({
      message: "Oops",
      variant: "error",
      duration: 1000,
      action: { label: "Retry", onClick },
    });
    const entry = toastStore.getSnapshot()[0];
    expect(entry.id).toBe(id);
    expect(entry.variant).toBe("error");
    expect(entry.duration).toBe(1000);
    expect(entry.action).toEqual({ label: "Retry", onClick });
  });

  it("auto-generates unique ids when none are provided", () => {
    const a = toastStore.show("A");
    const b = toastStore.show("B");
    expect(a).not.toBe(b);
    expect(toastStore.getSnapshot().map((t) => t.id)).toEqual([a, b]);
  });

  it("dedupes by caller-supplied id — second call replaces the first in place", () => {
    toastStore.show({ id: "save", message: "Saving…" });
    toastStore.show({ id: "save", message: "Saved!" });
    const snap = toastStore.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].message).toBe("Saved!");
  });

  it("stacks up to 3 toasts, dropping the oldest when a 4th arrives", () => {
    toastStore.show("a");
    toastStore.show("b");
    toastStore.show("c");
    toastStore.show("d");
    const messages = toastStore.getSnapshot().map((t) => t.message);
    expect(messages).toEqual(["b", "c", "d"]);
  });

  it("dismiss removes a toast by id and is a no-op for unknown ids", () => {
    const id = toastStore.show("gone");
    toastStore.show("stays");
    toastStore.dismiss(id);
    expect(toastStore.getSnapshot().map((t) => t.message)).toEqual(["stays"]);
    // unknown id — must not emit
    const sizeBefore = toastStore.getSnapshot().length;
    toastStore.dismiss("does-not-exist");
    expect(toastStore.getSnapshot().length).toBe(sizeBefore);
  });

  it("notifies subscribers on show and dismiss, and replays current state on subscribe", () => {
    const events: number[] = [];
    const unsub = toastStore.subscribe((toasts) => events.push(toasts.length));
    // first event = replay of empty state
    expect(events).toEqual([0]);

    toastStore.show("a");
    toastStore.show("b");
    expect(events).toEqual([0, 1, 2]);

    const id = toastStore.getSnapshot()[0].id;
    toastStore.dismiss(id);
    expect(events).toEqual([0, 1, 2, 1]);

    unsub();
    toastStore.show("c");
    // No further events after unsubscribe.
    expect(events).toEqual([0, 1, 2, 1]);
  });
});
