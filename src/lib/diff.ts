// Parse a stored unified diff into side-by-side rows. Purely presentational; no data is invented.
export type Cell = { no: number | null; text: string; type: "context" | "del" | "add" | "empty" };
export type Row =
  { kind: "hunk"; header: string } | { kind: "line"; left: Cell; right: Cell; modified: boolean };
export interface DiffFile {
  path: string;
  status: "modified" | "added" | "deleted";
  additions: number;
  deletions: number;
  rows: Row[];
}

const clean = (p: string) =>
  p
    .replace(/^[ab]\//, "")
    .replace(/\t.*$/, "")
    .trim();
const EMPTY: Cell = { no: null, text: "", type: "empty" };

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let oldNo = 0,
    newNo = 0;
  let dels: Cell[] = [],
    adds: Cell[] = [];
  const flush = () => {
    if (!cur) return;
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      const l = dels[i] ?? EMPTY,
        r = adds[i] ?? EMPTY;
      cur.rows.push({ kind: "line", left: l, right: r, modified: Boolean(dels[i] && adds[i]) });
    }
    dels = [];
    adds = [];
  };
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      flush();
      const from = clean(l.slice(4)),
        to = clean(lines[i + 1]!.slice(4));
      cur = {
        path: to === "/dev/null" ? from : to,
        status: from === "/dev/null" ? "added" : to === "/dev/null" ? "deleted" : "modified",
        additions: 0,
        deletions: 0,
        rows: [],
      };
      files.push(cur);
      i++;
      continue;
    }
    if (!cur || l.startsWith("Index:") || /^=+$/.test(l) || l.startsWith("\\ No newline")) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(l);
    if (h) {
      flush();
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      cur.rows.push({ kind: "hunk", header: l });
      continue;
    }
    if (l.startsWith("-")) {
      dels.push({ no: oldNo++, text: l.slice(1), type: "del" });
      cur.deletions++;
      continue;
    }
    if (l.startsWith("+")) {
      adds.push({ no: newNo++, text: l.slice(1), type: "add" });
      cur.additions++;
      continue;
    }
    if (l.startsWith(" ")) {
      flush();
      cur.rows.push({
        kind: "line",
        left: { no: oldNo++, text: l.slice(1), type: "context" },
        right: { no: newNo++, text: l.slice(1), type: "context" },
        modified: false,
      });
    }
  }
  flush();
  return files;
}
