import { beforeEach, describe, expect, it } from "vitest";
// full ".svelte.ts" URL on purpose: a bare ".svelte" import would resolve as
// a component and silently create a second store instance
import { cmdline } from "$lib/stores/cmdline.svelte.ts";

describe("cmdline history walking (Ctrl+E / Ctrl+X, alnavi-040)", () => {
  beforeEach(() => {
    // submit() keeps the NEWEST command first: [latest, ..., oldest]
    cmdline.history = ["ping b", "ping a", "cd .."];
    cmdline.histIndex = -1;
    cmdline.setText("");
  });

  it("first Ctrl+E recalls the LAST command, further presses go older", () => {
    cmdline.stepHistory(-1);
    expect(cmdline.text).toBe("ping b"); // newest, not the 100-deep oldest
    cmdline.stepHistory(-1);
    expect(cmdline.text).toBe("ping a");
    cmdline.stepHistory(-1);
    expect(cmdline.text).toBe("cd .."); // oldest — the end of the walk
  });

  it("Ctrl+E clamps at the oldest entry instead of wrapping", () => {
    for (let i = 0; i < 6; i++) cmdline.stepHistory(-1);
    expect(cmdline.text).toBe("cd ..");
    expect(cmdline.histIndex).toBe(2);
  });

  it("Ctrl+X walks forward and returns the half-typed draft past the newest", () => {
    cmdline.setText("half-typ");
    cmdline.stepHistory(-1); // newest
    cmdline.stepHistory(-1); // older
    expect(cmdline.text).toBe("ping a");
    cmdline.stepHistory(1); // forward again
    expect(cmdline.text).toBe("ping b");
    cmdline.stepHistory(1); // past the newest -> back to the draft
    expect(cmdline.text).toBe("half-typ");
    expect(cmdline.histIndex).toBe(-1);
    // another Ctrl+E restarts the walk from the newest, draft re-saved
    cmdline.stepHistory(-1);
    expect(cmdline.text).toBe("ping b");
  });

  it("empty history is a no-op", () => {
    cmdline.history = [];
    cmdline.stepHistory(-1);
    expect(cmdline.text).toBe("");
    expect(cmdline.histIndex).toBe(-1);
  });

  it("clear() (Esc) resets the walk: the next Ctrl+E starts from the newest", () => {
    cmdline.stepHistory(-1); // newest
    cmdline.stepHistory(-1); // mid
    cmdline.clear();
    expect(cmdline.text).toBe("");
    cmdline.stepHistory(-1);
    expect(cmdline.text).toBe("ping b"); // newest again, not history[2]
  });

  it("submit puts the command on top, drops the duplicate, resets the walk", () => {
    cmdline.setText("ping a");
    expect(cmdline.submit()).toBe(true);
    expect(cmdline.history).toEqual(["ping a", "ping b", "cd .."]);
    expect(cmdline.histIndex).toBe(-1);
    expect(cmdline.text).toBe("");
  });
});
