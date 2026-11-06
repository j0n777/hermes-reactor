import time

import pytest

from reactor_hermes.risk import classify

SAFE = [
    "ls", "ls -la src", "pwd", "cat README.md", "git status", "git diff --stat", "git log --oneline -5",
    "git show HEAD", "grep -rn TODO src", "cat a.txt | head -5", "echo hello", "git branch -a",
    "type notes.txt", r"dir C:\Users\x\proj",
]

DESTRUCTIVE = {
    "rm -rf build": "build",
    "rm notes.txt": "notes.txt",
    "del /s /q dist": "dist",
    r"rmdir /s /q C:\proj\dist": "dist",
    r"Remove-Item -Recurse -Force .\out": "out",
    "git reset --hard HEAD~3": "git reset --hard",
    "git push --force origin main": "force push",
    "git push origin +main": "force push",
    "git push origin :old-branch": "remoto",
    "git clean -fdx": "git clean",
    "git branch -D feature": "feature",
    "git stash drop": "stash",
    "git checkout -- .": "git checkout",
    "git rebase -i HEAD~5": "rebase",
    "curl -X DELETE https://api.example.com/users/1": "DELETE",
    "curl --request PUT https://api.example.com/x": "PUT",
    "wget --method=PATCH https://h.example/x": "PATCH",
    "kill -9 1234": "processos",
    "taskkill /F /IM node.exe": "processos",
    "mv a.txt b.txt": "b.txt",
    "cp -f a b": "b",
    "echo x > important.txt": "important.txt",
    "echo x >> log.txt": "log.txt",
    "dd if=/dev/zero of=/dev/sda": "dd",
    "mkfs.ext4 /dev/sdb1": "mkfs",
    "psql -c 'DROP TABLE users'": "SQL",
    "sqlite3 db 'delete from t'": "SQL",
    "find . -name '*.tmp' -delete": "find",
    "chmod -R 777 /": "chmod",
    "shred -u secret": "shred",
    "truncate -s 0 file": "truncate",
}

UNPARSEABLE = [
    "ls; rm -rf x\nls",
    "ls $(rm x)",
    "ls `rm x`",
    "ls ${HOME}",
    "echo %USERPROFILE%",
    "echo $HOME",
    "cat <<EOF\nx\nEOF",
    "cat <(ls)",
    "(rm x)",
    "{ rm x; }",
    "echo 'unclosed",
    'echo "unclosed',
    "ls \u202e txt.exe",
    "ls\u200bx",
    "ls\x00x",
    "l\\\ns",
    r"$'\x72m' x",
    "if true; then rm x; fi",
    "source env.sh",
    ". ./env.sh",
    "& rm x",
    "$cmd x",
    "r* x",
    "bash -c 'rm -rf x'",
    "cmd /c del x",
    "powershell -Command Remove-Item x",
    "!rm",
    "echo x # comment",
    "FOO=1 ls",
    r"ls\ x",
    "x" * 20000,
    "ls\ttab\r",
]

UNKNOWN = ["pnpm test", "python script.py", "npm publish", "node x.js", "make", "sudo ls", "env ls", "xargs rm",
           "curl https://example.com", "git commit -m x", "git config user.name x", "git diff --ext-diff",
           "git -c core.pager=sh diff", "git diff --output=out.txt", "rg --pre ./evil pattern", "sort -o f f"]


@pytest.mark.parametrize("cmd", SAFE)
def test_safe(cmd):
    v = classify(cmd)
    assert v["level"] == "safe", v
    assert v["does"] is None and v["may"] is None


@pytest.mark.parametrize("cmd,needle", list(DESTRUCTIVE.items()))
def test_destructive(cmd, needle):
    v = classify(cmd, lang="pt-BR")
    assert v["level"] == "risky" and v["kind"] == "destructive", v
    assert v["does"] and v["may"]
    assert needle.lower() in (v["does"] + v["may"]).lower() or needle in cmd, v


@pytest.mark.parametrize("cmd", UNPARSEABLE)
def test_unparseable_is_risky(cmd):
    v = classify(cmd)
    assert v["level"] == "risky", v
    assert v["kind"] == "unparseable", v
    assert v["does"] and v["may"]


@pytest.mark.parametrize("cmd", UNKNOWN)
def test_unknown_is_risky(cmd):
    v = classify(cmd)
    assert v["level"] == "risky", v


@pytest.mark.parametrize("bad", [None, 42, [], {}, b"ls", ""])
def test_non_string_or_empty_fails_closed(bad):
    assert classify(bad)["level"] == "risky"


def test_pipeline_is_only_as_safe_as_every_stage():
    assert classify("cat a | head")["level"] == "safe"
    assert classify("cat a | sh")["level"] == "risky"
    assert classify("cat a && rm -rf x")["kind"] == "destructive"
    assert classify("ls || curl -X DELETE http://h/x")["kind"] == "destructive"
    assert classify("ls & rm x")["level"] == "risky"


def test_texts_are_fixed_and_localised():
    pt = classify("rm -rf dist", lang="pt-BR")
    en = classify("rm -rf dist", lang="en")
    assert pt["does"].startswith("Apaga a pasta")
    assert en["does"].startswith("Deletes the folder")
    assert pt["may"] != en["may"]
    unp = classify("echo $(x)", lang="pt-BR")
    assert "não consegue analisar" in unp["does"]


def test_names_in_text_are_sanitised():
    v = classify("rm -rf 'a`b'")
    assert "`ab`" in v["does"]
    assert v["does"].count("`") == 2
    for bad in ("rm -rf 'x‮y'", "rm -rf 'xy'"):
        text = classify(bad)["does"] + classify(bad)["may"]
        assert "‮" not in text and "" not in text
    long = classify("rm -rf " + "d/" * 200)
    assert len(long["does"]) <= 200 and "…" in long["does"]


def test_no_command_text_in_unparseable_reason():
    v = classify("echo $(cat /etc/very-secret-thing)")
    assert "very-secret-thing" not in str(v)


def test_linear_time_on_huge_input():
    start = time.time()
    classify("a " * 4000)
    classify("'" * 100000)
    classify("(" * 100000)
    assert time.time() - start < 2.0


def test_verdict_has_stable_codes():
    assert classify("echo $(x)")["codes"] == ["command_substitution"]
    assert classify("rm -rf x")["codes"] == ["destructive"]
