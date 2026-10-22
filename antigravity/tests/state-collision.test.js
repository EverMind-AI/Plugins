import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { getSessionFilePath } from "../hooks/scripts/lib/state.js";

test("state: getSessionFilePath eliminates session collisions via SHA-1 suffix (D7-02)", () => {
  const dir = "C:/mock/data";
  const ids = ["conv:alpha", "conv/alpha", "conv\\alpha", "conv alpha"];
  const filePaths = ids.map((id) => getSessionFilePath(dir, id));

  // Each distinct id must produce a distinct filename
  const uniquePaths = new Set(filePaths);
  assert.equal(uniquePaths.size, ids.length);

  for (const fp of filePaths) {
    const filename = path.basename(fp);
    assert.match(filename, /^session_conv_alpha_[0-9a-f]{8}\.json$/);
  }
});
