"""A stand-in for `claude` and `codex`, for tests only. It never touches a real CLI, ~/.claude or ~/.codex.

The behaviour is chosen by the first line of the instruction it reads on standard input:

    ECHO                      print {"argv", "stdin", "cwd"} as JSON
    EXIT <n>                  exit with code n after printing a line
    SLEEP                     sleep for a minute (killed by timeout or cancel)
    TREE <pidfile>            start a grandchild, write both pids to <pidfile>, then sleep
    ORPHAN <pidfile>          start a grandchild, write both pids, then exit at once (the grandchild lingers)
    COUNT <file>              append one line to <file> (counts how many times it ran), print "counted"
    FLOOD <megabytes>         print that much output, ending with the marker END-OF-FLOOD
    ENV                       print the environment as JSON
    COLOR                     print ANSI colour sequences and control characters
"""

import json
import os
import subprocess
import sys
import time

data = sys.stdin.buffer.read().decode("utf-8", "replace")
first = data.split("\n", 1)[0].strip()
parts = first.split()
cmd = parts[0] if parts else ""


def spawn_sleeper():
    code = "import time; time.sleep(120)"
    return subprocess.Popen([sys.executable, "-c", code], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def out_text(text):
    sys.stdout.buffer.write(text.encode("utf-8"))
    sys.stdout.buffer.flush()


if cmd == "ECHO":
    out_text(json.dumps({"argv": sys.argv[1:], "stdin": data, "cwd": os.getcwd()}))
elif cmd == "EXIT":
    out_text("exiting\n")
    sys.exit(int(parts[1]))
elif cmd == "SLEEP":
    out_text("sleeping\n")
    time.sleep(60)
elif cmd in ("TREE", "ORPHAN"):
    child = spawn_sleeper()
    with open(parts[1], "w", encoding="utf-8") as fh:
        json.dump({"parent": os.getpid(), "child": child.pid}, fh)
    out_text("tree ready\n")
    if cmd == "TREE":
        time.sleep(60)
elif cmd == "COUNT":
    with open(parts[1], "a", encoding="utf-8") as fh:
        fh.write("run\n")
    out_text("counted\n")
elif cmd == "FLOOD":
    megabytes = int(parts[1])
    line = ("x" * 1023 + "\n").encode()
    out = sys.stdout.buffer
    for _ in range(megabytes * 1024):
        out.write(line)
    out.write(b"END-OF-FLOOD\n")
    out.flush()
elif cmd == "ENV":
    out_text(json.dumps(dict(os.environ)))
elif cmd == "COLOR":
    esc = chr(27)
    bell = chr(7)
    bidi = chr(0x202E)
    out_text(f"{esc}[31mred{esc}[0m {esc}]0;title{bell} bell{bell} bidi{bidi} end\n")
else:
    out_text("unknown instruction\n")
    sys.exit(3)
