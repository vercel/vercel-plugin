import { beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import * as inject from "../hooks/pretooluse-skill-inject.mjs";
import { stripHeredocBodies } from "../hooks/patterns.mjs";

// Issue #158: text inside a heredoc body is data the command writes (a test
// fixture, a markdown file, a gh issue body), not a command it runs, so it
// must not force-inject skills. The env-vars skill (bashPattern
// '\bvercel\s+env\s+pull\b') is the control.

const ROOT = resolve(import.meta.dirname, "..");
const { loadSkills, matchSkills } = inject;

let compiledSkills: ReturnType<typeof loadSkills> extends infer T
  ? T extends { compiledSkills: infer C }
    ? C
    : never
  : never;

function matched(command: string): string[] {
  return [...matchSkills("Bash", { command }, compiledSkills)!.matched];
}

beforeAll(() => {
  compiledSkills = loadSkills(ROOT)!.compiledSkills;
});

describe("bash heredoc bodies (#158)", () => {
  test("control: a real vercel env pull matches env-vars", () => {
    expect(matched("vercel env pull .env.local")).toContain("env-vars");
  });

  test("vercel env pull inside a heredoc body does not match", () => {
    const command = "cat > notes.md <<'EOF'\nRun vercel env pull .env.local first.\nEOF";
    expect(matched(command)).not.toContain("env-vars");
  });

  test("<<- with a tab-indented terminator does not match", () => {
    const command = "cat > notes.md <<-EOF\n\tRun vercel env pull .env.local first.\n\tEOF";
    expect(matched(command)).not.toContain("env-vars");
  });

  test("a command after the heredoc operator still matches", () => {
    const command = "cat <<EOF | vercel env pull .env.local\nhello\nEOF";
    expect(matched(command)).toContain("env-vars");
  });

  test("a command after the terminator still matches", () => {
    const command = "cat > a.txt <<EOF\nx\nEOF\nvercel env pull .env.local";
    expect(matched(command)).toContain("env-vars");
  });

  test("a here-string is not a heredoc", () => {
    expect(matched("vercel env pull .env.local <<< y")).toContain("env-vars");
  });
});

describe("stripHeredocBodies", () => {
  test("consumes two heredocs on one line in order", () => {
    const command = "cat <<A <<B\nbody a\nA\nbody b\nB\nvercel env pull .env.local";
    expect(stripHeredocBodies(command)).toBe(
      "cat <<A <<B\nA\nB\nvercel env pull .env.local",
    );
  });

  test("an unterminated heredoc keeps the whole command", () => {
    expect(stripHeredocBodies("cat <<EOF\nvercel env pull .env.local")).toBe("cat <<EOF\nvercel env pull .env.local");
  });

  test("an unquoted all-digits word after << is not a heredoc", () => {
    // bash arithmetic like $((1<<2)) must not strip the following lines
    const command = "echo $((1<<2))\nvercel env pull .env.local";
    expect(stripHeredocBodies(command)).toBe(command);
  });

  test("B1 escaped quotes do not end a double-quoted string", () => {
    const command = "printf \"%s\\n\" \"literal \\\" <<EOF text\"\nvercel env pull .env.local";
    expect(stripHeredocBodies(command)).toBe(command);
  });

  test("B2 CRLF terminators end the heredoc body", () => {
    const command = "cat <<EOF\r\nx\r\nEOF\r\nvercel env pull .env.local";
    expect(stripHeredocBodies(command)).toBe("cat <<EOF\r\nEOF\r\nvercel env pull .env.local");
  });

  test("B3 hyphenated delimiters are heredoc words", () => {
    const command = "cat <<END-MESSAGE\nvercel env pull .env.local\nEND-MESSAGE";
    expect(stripHeredocBodies(command)).toBe("cat <<END-MESSAGE\nEND-MESSAGE");
  });

  test("B4 arithmetic shift is not a heredoc", () => {
    const command = "echo $((1<<EOF))\nvercel env pull .env.local";
    expect(stripHeredocBodies(command)).toBe(command);
  });

  test("B5 a comment is not a heredoc", () => {
    const command = "# <<EOF\nvercel env pull .env.local";
    expect(stripHeredocBodies(command)).toBe(command);
  });

  test("B6 concatenated quoted delimiters are joined", () => {
    const command = "cat <<E\"OF\"\nbody vercel env pull\nEOF\nvercel env pull .env.local";
    expect(stripHeredocBodies(command)).toBe("cat <<E\"OF\"\nEOF\nvercel env pull .env.local");
  });

  test("B5b a # inside a word is not a comment", () => {
    expect(stripHeredocBodies("cat a#b <<EOF\nvercel env pull\nEOF")).toBe("cat a#b <<EOF\nEOF");
  });

  test("B7 a continued operator line is still command text", () => {
    const command = "cat <<EOF \\\nvercel env pull .env.local\nEOF";
    expect(stripHeredocBodies(command)).toBe("cat <<EOF \\\nvercel env pull .env.local\nEOF");
  });

  test("B7b a heredoc opened on a continued line is consumed in order", () => {
    const command = "cat <<A \\\n<<B\nbody A\nA\nbody B vercel env pull\nB";
    expect(stripHeredocBodies(command)).toBe("cat <<A \\\n<<B\nA\nB");
  });

  test("B7c an escaped backslash at the end does not continue", () => {
    const command = "cat <<EOF \\\\\nbody vercel env pull\nEOF";
    expect(stripHeredocBodies(command)).toBe("cat <<EOF \\\\\nEOF");
  });

  test("B8 a quote open across lines hides <<", () => {
    const command = 'printf "prefix \\\n<<EOF""\nvercel env pull .env.local\nEOF';
    expect(stripHeredocBodies(command)).toBe(command);
  });

  test("B8b a plain multi-line quote hides <<", () => {
    const command = 'echo "a\n<<EOF"\nvercel env pull .env.local\nEOF';
    expect(stripHeredocBodies(command)).toBe(command);
  });

  test("B8c a heredoc after a closed multi-line quote still strips", () => {
    const command = 'echo "a\nb" <<EOF\nbody vercel env pull\nEOF';
    expect(stripHeredocBodies(command)).toBe('echo "a\nb" <<EOF\nEOF');
  });

  test("B9 arithmetic open across lines hides <<", () => {
    const command = 'echo $((1\n<<EOF\n))\nvercel env pull .env.local\nEOF';
    expect(stripHeredocBodies(command)).toBe(command);
  });

  test("B9b a heredoc after a closed multi-line arithmetic still strips", () => {
    const command = 'echo $((1\n+2)) <<EOF\nbody vercel env pull\nEOF';
    expect(stripHeredocBodies(command)).toBe('echo $((1\n+2)) <<EOF\nEOF');
  });

  test("B10 << inside ${...} is not a heredoc", () => {
    const command = 'echo ${x:-<<EOF}\nvercel env pull .env.local\nEOF';
    expect(stripHeredocBodies(command)).toBe(command);
  });

  test("B10b ${ open across lines hides <<", () => {
    const command = 'echo ${x:-a\n<<EOF}\nvercel env pull .env.local\nEOF';
    expect(stripHeredocBodies(command)).toBe(command);
  });
  test("B11 a backslash inside a double-quoted delimiter keeps the command", () => {
    const command = 'cat <<"E\\OF"\nEOF\ncat <<X\nE\\OF\nvercel env pull .env.local\nX';
    expect(stripHeredocBodies(command)).toBe(command);
  });

  test("B11b <<\\EOF strips like <<EOF", () => {
    expect(stripHeredocBodies('cat <<\\EOF\nbody vercel env pull\nEOF')).toBe('cat <<\\EOF\nEOF');
  });

  test("B11c a delimiter with $ keeps the command", () => {
    const command = 'cat <<$X\nvercel env pull .env.local\n$X';
    expect(stripHeredocBodies(command)).toBe(command);
  });

  test("B12 a terminator with a trailing space does not end the body", () => {
    expect(stripHeredocBodies('cat <<EOF\nEOF \ncat <<X\nEOF\nvercel env pull .env.local\nX')).toBe(
      'cat <<EOF\nEOF\nvercel env pull .env.local\nX',
    );
  });

  test("B12b <<- with a space-indented terminator does not end the body", () => {
    expect(stripHeredocBodies('cat <<-EOF\n EOF\ncat <<X\nEOF\nvercel env pull .env.local\nX')).toBe(
      'cat <<-EOF\nEOF\nvercel env pull .env.local\nX',
    );
  });

  test("B13 a comment after ; hides <<", () => {
    const command = 'echo hi;# <<EOF\nvercel env pull .env.local\nEOF';
    expect(stripHeredocBodies(command)).toBe(command);
  });

  test("B14 an all-digits delimiter keeps the command", () => {
    const command = 'cat <<1\ncat <<X\n1\nvercel env pull .env.local\nX';
    expect(stripHeredocBodies(command)).toBe(command);
  });

  test("B15 a quoted delimiter with a space keeps the command", () => {
    const command = "cat <<'A B'\ncat <<X\nA B\nvercel env pull .env.local\nX";
    expect(stripHeredocBodies(command)).toBe(command);
  });
  test("B16 a # after a backslash-joined word is not a comment", () => {
    expect(stripHeredocBodies('echo foo\\\n#bar <<EOF\ncat <<X\nEOF\nvercel env pull .env.local\nX')).toBe(
      'echo foo\\\n#bar <<EOF\nEOF\nvercel env pull .env.local\nX',
    );
  });
});
