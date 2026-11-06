"""Risk classifier for one command line that may be bash, PowerShell or cmd.

Ported in spirit from the Reactor core permission gate (a hand-written, regex-free tokenizer plus fixed sentences).
Fail closed: only a short list of read-only programs is ever "safe". Anything destructive, anything the tokenizer
does not fully understand and anything it does not recognise is "risky". The two sentences shown to people
("what it does", "what may happen") come from fixed templates in :mod:`reactor_hermes.i18n`; nothing a model writes
reaches them, and the only text taken from the command is a sanitised name (a path, a host, a branch).

This module only reads text. It never runs anything.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .i18n import normalize_lang, t
from .text import clean

COMMAND_LINE_MAX = 8192
NAME_MAX = 48
SENTENCE_MAX = 200


@dataclass(frozen=True)
class Word:
    text: str  # quotes removed; backslashes and cmd carets kept (how a path is shown)
    bare: str  # quotes, backslashes and carets removed (how a shell may really read it)


@dataclass
class Cmd:
    words: list = field(default_factory=list)
    redirects: list = field(default_factory=list)  # (op, target)
    joined_by: str = "start"  # start | seq | pipe


class Unparseable(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


# --- lexer -----------------------------------------------------------------------------------------------------------

_ESCAPE_AMBIGUOUS = set(";&|<>(){}'\"`")
_QUOTED_WORD_ENDS = set(" \t;&|<>")
_CMD_OPERATORS = set("&|<>^\"")
_RESERVED = {
    "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "in", "select",
    "function", "time", "coproc", "!", "exist", "not", "errorlevel",
}
_SHELLS = {"cmd", "bash", "sh", "zsh", "dash", "ksh", "fish", "powershell", "pwsh", "wsl", "busybox", "nu", "csh", "tcsh"}
_CMD_BUILTINS = {
    "assoc", "attrib", "break", "call", "cd", "chdir", "cls", "cmd", "color", "copy", "date", "del", "dir", "echo",
    "endlocal", "erase", "exit", "for", "format", "ftype", "goto", "if", "md", "mkdir", "mklink", "move", "path",
    "pause", "popd", "prompt", "pushd", "rd", "rem", "ren", "rename", "rmdir", "set", "setlocal", "shift", "start",
    "time", "title", "type", "ver", "verify", "vol",
}
_CMD_NAME_ENDS = set(".+[]:,=/\\")
_NULL_DEVICES = {"/dev/null", "$null", "nul", "nul:", "/dev/stdout", "/dev/stderr"}


def _forbidden(ch: str) -> Optional[str]:
    code = ord(ch)
    if code in (10, 13):
        return "multiline"
    if code == 9:
        return None
    if code < 0x20 or 0x7F <= code <= 0x9F:
        return "control_char"
    if (
        code in (0xA0, 0xAD, 0x061C, 0x1680, 0x180E, 0x3000, 0xFEFF)
        or 0x2000 <= code <= 0x206F
        or 0xE0000 <= code <= 0xE007F
        or 0xFE00 <= code <= 0xFE0F
        or code in (0x3164, 0xFFA0, 0x115F, 0x1160) or 0x180B <= code <= 0x180D  # blank-looking fillers, Mongolian selectors
        or 0xFF01 <= code <= 0xFF5E  # full-width look-alikes of ASCII punctuation and letters
        or 0x2212 == code
    ):
        return "unicode"
    return None


def _is_name_start(c: str) -> bool:
    return c.isascii() and (c.isalpha() or c == "_")


def _is_assignment(text: str) -> bool:
    if len(text) < 2 or not _is_name_start(text[0]):
        return False
    for ch in text[1:]:
        if ch == "=":
            return True
        if not (_is_name_start(ch) or ch.isdigit()):
            return False
    return False


def lex(line: str) -> list:
    """Split a line into simple commands, or raise :class:`Unparseable` with a fixed code."""
    if len(line) > COMMAND_LINE_MAX:
        raise Unparseable("too_long")
    for ch in line:
        why = _forbidden(ch)
        if why:
            raise Unparseable(why)
    if line.count("%") >= 2:
        raise Unparseable("expansion")

    n = len(line)
    i = 0
    cmds: list = []
    cur = Cmd()
    text_parts: list = []
    bare_parts: list = []
    in_token = False
    quoted_token = False
    pending_join = "start"

    def flush() -> None:
        nonlocal text_parts, bare_parts, in_token, quoted_token
        if in_token:
            cur.words.append(Word("".join(text_parts), "".join(bare_parts)))
        text_parts, bare_parts, in_token, quoted_token = [], [], False, False

    def end_command(join_next: str) -> None:
        nonlocal cur, pending_join
        flush()
        if not cur.words:
            raise Unparseable("empty_program")
        cmds.append(cur)
        pending_join = join_next
        cur = Cmd(joined_by=join_next)

    def read_word_at(start: int) -> tuple:
        """A redirect target: unquoted run or one quoted string. Returns (text, next_index)."""
        j = start
        while j < n and line[j] in " \t":
            j += 1
        if j >= n or line[j] in ";&|<>()":
            raise Unparseable("no_target")
        if line[j] in "$`%":
            raise Unparseable("expansion")
        if line[j] in "'\"":
            q = line[j]
            k = line.find(q, j + 1)
            if k < 0:
                raise Unparseable("unclosed_quote")
            body = line[j + 1 : k]
            if "$" in body or "`" in body:
                raise Unparseable("expansion")
            return body, k + 1
        k = j
        while k < n and line[k] not in " \t;&|<>()":
            if line[k] in "$`'\"":
                raise Unparseable("expansion" if line[k] == "$" else "ambiguous_escape")
            k += 1
        return line[j:k], k

    while i < n:
        c = line[i]
        if c in " \t":
            flush()
            i += 1
            continue
        if c == ";":
            end_command("seq")
            i += 1
            continue
        if c == "&":
            nxt = line[i + 1] if i + 1 < n else ""
            if nxt == ">":
                raise Unparseable("ambiguous_redirect")
            end_command("seq")
            i += 2 if nxt == "&" else 1
            continue
        if c == "|":
            nxt = line[i + 1] if i + 1 < n else ""
            if nxt == "&":
                raise Unparseable("ambiguous_redirect")
            if nxt == "|":
                end_command("seq")
                i += 2
            else:
                end_command("pipe")
                i += 1
            continue
        if c in "<>":
            nxt = line[i + 1] if i + 1 < n else ""
            if nxt == "(":
                raise Unparseable("process_substitution")
            if c == "<" and nxt == "<":
                raise Unparseable("here_doc")
            # an all-digit unquoted token glued to the operator is a file descriptor (2>&1, 2>x)
            if in_token and not quoted_token and "".join(text_parts).isdigit():
                text_parts, bare_parts, in_token = [], [], False
            else:
                flush()
            if c == ">" and nxt == "&":
                j = i + 2
                k = j
                while k < n and (line[k].isdigit() or line[k] == "-"):
                    k += 1
                if k == j:
                    raise Unparseable("ambiguous_redirect")
                cur.redirects.append(("dup", line[j:k]))
                i = k
                continue
            op = c
            i += 1
            if c == ">" and nxt == ">":
                op = ">>"
                i += 1
            target, i = read_word_at(i)
            cur.redirects.append((op, target))
            continue
        if c == "(" or c == ")":
            raise Unparseable("parentheses")
        if c == "`":
            raise Unparseable("backtick")
        if c == "$":
            nxt = line[i + 1] if i + 1 < n else ""
            if nxt == "(":
                raise Unparseable("command_substitution")
            if nxt == "'":
                raise Unparseable("ansi_c_quote")
            if nxt == '"':
                raise Unparseable("locale_quote")
            if nxt == "[":
                raise Unparseable("arithmetic")
            raise Unparseable("expansion")
        if c == "{" or c == "}":
            if not in_token:
                raise Unparseable("braces")
            text_parts.append(c)
            bare_parts.append(c)
            i += 1
            continue
        if c == "#" and not in_token:
            raise Unparseable("comment")
        if c == "!" and not in_token and not cur.words:
            raise Unparseable("history_expansion")
        if c == "\\":
            nxt = line[i + 1] if i + 1 < n else ""
            if nxt == "":
                raise Unparseable("line_continuation")
            if nxt in _ESCAPE_AMBIGUOUS or nxt in " \t":
                raise Unparseable("escaped_space" if nxt in " \t" else "ambiguous_escape")
            in_token = True
            text_parts.append("\\")  # kept for display; dropped from the bare form
            i += 1
            continue
        if c == "^":
            in_token = True
            text_parts.append("^")
            i += 1
            continue
        if c == "'":
            k = line.find("'", i + 1)
            if k < 0:
                raise Unparseable("unclosed_quote")
            body = line[i + 1 : k]
            for ch in body:
                if ch in _CMD_OPERATORS:
                    raise Unparseable("ambiguous_quote")
            if k + 1 < n and line[k + 1] not in _QUOTED_WORD_ENDS:
                raise Unparseable("quote_split")
            in_token = True
            quoted_token = True
            text_parts.append(body)
            bare_parts.append(body)
            i = k + 1
            continue
        if c == '"':
            j = i + 1
            buf: list = []
            while True:
                if j >= n:
                    raise Unparseable("unclosed_quote")
                d = line[j]
                if d == '"':
                    break
                if d == "$":
                    raise Unparseable("expansion")
                if d == "`":
                    raise Unparseable("backtick")
                if d == "\\":
                    nxt = line[j + 1] if j + 1 < n else ""
                    if nxt in ('"', "$", "`", "\\"):
                        raise Unparseable("ambiguous_escape")
                    buf.append(d)
                    j += 1
                    continue
                buf.append(d)
                j += 1
            if j + 1 < n and line[j + 1] not in _QUOTED_WORD_ENDS:
                raise Unparseable("quote_split")
            body = "".join(buf)
            in_token = True
            quoted_token = True
            text_parts.append(body)
            bare_parts.append(body)
            i = j + 1
            continue
        in_token = True
        text_parts.append(c)
        bare_parts.append(c)
        i += 1

    flush()
    if cur.words or cur.redirects:
        if not cur.words:
            raise Unparseable("empty_program")
        cmds.append(cur)
    elif pending_join == "pipe":
        raise Unparseable("empty_program")
    if not cmds:
        raise Unparseable("empty_program")
    for cmd in cmds:
        _check_program(cmd)
    return cmds


def _program_name(text: str) -> str:
    cut = max(text.rfind("/"), text.rfind("\\"))
    name = (text[cut + 1 :] if cut >= 0 else text).lower()
    return name[:-4] if name.endswith(".exe") else name


def _check_program(cmd: Cmd) -> None:
    words = cmd.words
    if _is_assignment(words[0].text):
        name = words[0].text.split("=", 1)[0].lower()
        if name in _CMD_BUILTINS:
            raise Unparseable("glued_program")
        if all(_is_assignment(w.text) for w in words):
            raise Unparseable("assignment_only")
        raise Unparseable("assignment_prefix")
    first = words[0]
    bare = first.bare.lstrip("@").lower()
    text = first.text.lstrip("@").lower()
    if not bare or not text:
        raise Unparseable("empty_program")
    if bare in _RESERVED or text in _RESERVED:
        raise Unparseable("reserved_word")
    if bare in (".", "source"):
        raise Unparseable("source")
    if bare in ("&",):
        raise Unparseable("call_operator")
    if bare not in ("[", "[[") and any(ch in bare for ch in "*?["):
        raise Unparseable("glob_program")
    if any(ch in text for ch in ",="):
        raise Unparseable("glued_program")
    if "/" in text and "\\" in text:
        raise Unparseable("glued_program")
    for form in (text, bare):
        for idx, ch in enumerate(form):
            if ch in _CMD_NAME_ENDS and idx > 0:
                if form[:idx] in _CMD_BUILTINS and form != "cmd.exe":
                    raise Unparseable("glued_program")
                break
    name = _program_name(text)
    name_bare = _program_name(bare)
    if name in _SHELLS or name_bare in _SHELLS:
        raise Unparseable("shell_payload")
    if name in _CMD_BUILTINS or name_bare in _CMD_BUILTINS:
        for w in words[1:]:
            if any(ch in w.text for ch in ",="):
                raise Unparseable("glued_program")


# --- reading commands --------------------------------------------------------------------------------------------------


def _program(cmd: Cmd) -> str:
    return _program_name(cmd.words[0].bare.lstrip("@").lower())


def _lower(w: Word) -> str:
    return w.bare.lower()


def _is_opt(w: Word) -> bool:
    return w.bare.startswith("-")


def _is_switch(w: Word) -> bool:
    return len(w.bare) <= 3 and w.bare.startswith("/") and "/" not in w.bare[1:]


def _shown(w: Word) -> str:
    return w.text.replace("^", "")


def _name(text: str) -> str:
    flat = " ".join(clean(text, 0).replace("`", "").split())
    if len(flat) <= NAME_MAX:
        return flat
    if "/" in flat or "\\" in flat:
        return "…" + flat[-(NAME_MAX - 1) :]
    return flat[: NAME_MAX - 1] + "…"


def _code(text: str) -> str:
    return f"`{_name(text)}`"


def _sentence(text: str) -> str:
    return text if len(text) <= SENTENCE_MAX else text[: SENTENCE_MAX - 1] + "…"


_RM = {"rm", "rmdir", "del", "erase", "rd", "remove-item", "ri", "rimraf", "unlink", "srm"}
_FOLDER_RM = {"rmdir", "rd"}
_PS_NON_PATH = {"-filter", "-include", "-exclude", "-credential", "-stream"}
_PS_PATH = {"-path", "-literalpath"}
_KILL = {"kill", "pkill", "killall", "taskkill", "stop-process", "spps", "tskill", "xkill"}
_MOVE = {"mv", "move", "move-item", "mi", "ren", "rename", "rename-item", "rni"}
_COPY = {"cp", "copy", "copy-item", "cpi", "xcopy", "robocopy", "rsync", "scp"}
_NET = {"curl", "wget", "invoke-webrequest", "invoke-restmethod", "iwr", "irm", "http", "https", "httpie", "xh", "xhs"}
_DISK = {"dd", "format", "mkswap", "wipefs", "diskpart", "fdisk", "parted", "sgdisk"}
_SHRED = {"shred", "truncate", "cipher", "sdelete"}
_PERM = {"chmod", "chown", "chgrp", "icacls", "takeown", "attrib"}


def _targets(args: list) -> list:
    out = []
    i = 0
    while i < len(args):
        w = args[i]
        low = _lower(w)
        if low in _PS_PATH and i + 1 < len(args):
            out.append(_shown(args[i + 1]))
            i += 2
            continue
        if low in _PS_NON_PATH:
            i += 2
            continue
        if _is_opt(w) or _is_switch(w):
            i += 1
            continue
        out.append(_shown(w))
        i += 1
    return out


def _looks_like_file(path: str) -> bool:
    parts = [p for p in path.replace("/", "\\").split("\\") if p]
    last = parts[-1] if parts else ""
    dot = last.rfind(".")
    if dot <= 0 or dot == len(last) - 1:
        return False
    ext = last[dot + 1 :]
    return len(ext) <= 5 and ext.isalnum() and "*" not in last


def _removal(program: str, args: list, lang: str) -> tuple:
    paths = _targets(args)
    recursive = program in _FOLDER_RM or program == "rimraf" or any(
        _lower(w) in ("--recursive", "-recurse", "/s")
        or (len(w.bare) > 1 and w.bare[0] == "-" and w.bare[1] != "-" and ("r" in w.bare[1:].lower()))
        for w in args
    )
    if not paths:
        return t("rm.none.does", lang), t("rm.none.may", lang)
    more_n = len(paths) - 1
    more = "" if more_n == 0 else (t("more.one", lang) if more_n == 1 else t("more.many", lang, n=more_n))
    if recursive and not _looks_like_file(paths[0]):
        return t("rm.folder.does", lang, path=_code(paths[0]), more=more), t("rm.folder.may", lang)
    return t("rm.file.does", lang, path=_code(paths[0]), more=more), t("rm.none.may", lang)


_GIT_VALUE_OPTS = {"-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix"}


def _git(args: list, lang: str) -> Optional[tuple]:
    i = 0
    while i < len(args):
        a = args[i].bare
        if a in _GIT_VALUE_OPTS:
            i += 2
        elif _is_opt(args[i]):
            i += 1
        else:
            break
    if i >= len(args):
        return None
    sub = args[i].bare.lower()
    rest = args[i + 1 :]
    flags = [_lower(w) for w in rest]
    plain = [w for w in rest if not _is_opt(w)]

    def has(*f: str) -> bool:
        # git accepts any unambiguous prefix of a long option (`--del` is `--delete`), so a flag counts when it is a
        # prefix (3 characters or more) of one of the long names asked for, or the name itself.
        for x in flags:
            if x in f:
                return True
            name = x.split("=", 1)[0]
            if name.startswith("--") and len(name) >= 3 and any(g.startswith("--") and g.startswith(name) for g in f):
                return True
        return False

    def cluster(letters: str) -> bool:
        return any(
            len(w.bare) > 1 and w.bare[0] == "-" and w.bare[1] != "-" and any(ch in w.bare[1:] for ch in letters)
            for w in rest
        )

    last = plain[-1].bare if plain else "?"
    if sub == "push":
        force = has("--force", "--force-if-includes") or any(x.startswith("--force-with-lease") for x in flags) \
            or cluster("f") or any(w.bare.startswith("+") for w in plain)
        remove = has("--delete") or cluster("d") or any(w.bare.startswith(":") for w in plain)
        if has("--mirror"):
            return t("git.mirror.does", lang), t("git.mirror.may", lang)
        if remove:
            return t("git.pushdel.does", lang), t("git.pushdel.may", lang)
        if force:
            return t("git.force.does", lang), t("git.force.may", lang)
        return None
    if sub == "reset":
        if has("--hard", "--merge"):
            return t("git.reset.does", lang), t("git.reset.may", lang)
        return None
    if sub == "clean":
        return t("git.clean.does", lang), t("git.clean.may", lang)
    if sub in ("checkout", "restore", "switch"):
        return t("git.discard.does", lang, sub=sub), t("git.discard.may", lang)
    if sub == "branch":
        if cluster("dDf") or has("--delete", "--force"):
            return t("git.branchdel.does", lang, name=_code(last)), t("git.branchdel.may", lang)
        return None
    if sub == "tag":
        if cluster("dDf") or has("--delete", "--force"):
            return t("git.tagdel.does", lang, name=_code(last)), t("git.tagdel.may", lang)
        return None
    if sub == "stash":
        if plain and plain[0].bare.lower() in ("drop", "clear"):
            return t("git.stashdrop.does", lang), t("git.stashdrop.may", lang)
        return None
    if sub == "rm":
        return t("git.rm.does", lang), t("git.rm.may", lang)
    if sub in ("rebase", "filter-branch", "filter-repo", "reflog", "gc", "update-ref", "replace"):
        return t("git.history.does", lang, sub=sub), t("git.history.may", lang)
    return None


_DATA_FLAGS = {
    "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "-f", "--form", "-t",
    "--upload-file", "--json", "-body", "--post-data", "--post-file", "--body-data", "--body-file",
}


def _http_method(args: list) -> Optional[str]:
    """DELETE / PUT / PATCH when the line says so, 'POST' for other writes, None for a plain read."""
    low = [_lower(w) for w in args]
    method = None
    for idx, a in enumerate(low):
        if a in ("-x", "--request", "-method", "--method") and idx + 1 < len(low):
            method = low[idx + 1].upper()
        elif a.startswith("--request=") or a.startswith("--method="):
            method = a.split("=", 1)[1].upper()
        elif a.startswith("-x") and len(a) > 2 and not a.startswith("--"):
            method = a[2:].upper()
    if method in ("DELETE", "PUT", "PATCH"):
        return method
    if method and method not in ("GET", "HEAD", "OPTIONS"):
        return "POST"
    if any(a in _DATA_FLAGS or a.split("=", 1)[0] in _DATA_FLAGS for a in low):
        return "POST"
    return None


def _host_of(args: list) -> Optional[str]:
    for w in args:
        tx = w.bare
        scheme = tx.find("://")
        if scheme < 0:
            continue
        tx = tx[scheme + 3 :]
        end = len(tx)
        for k, ch in enumerate(tx):
            if ch in "/?#":
                end = k
                break
        host = tx[:end]
        if "@" in host:
            host = host.rsplit("@", 1)[1]
        if host and all(ch.isalnum() or ch in "._:[]-" for ch in host):
            return _name(host)
    return None


def _network(args: list, program: str, lang: str) -> tuple:
    """Returns (destructive?, does, may). A plain read is not destructive but still needs a look."""
    method = _http_method(args)
    host = _host_of(args)
    to = t("net.to", lang, host=_code(host)) if host else ""
    if program in ("http", "https", "httpie", "xh", "xhs"):
        first = [_lower(w) for w in args if not _is_opt(w)][:3]
        for m in ("delete", "put", "patch"):
            if m in first:
                method = m.upper()
    if method == "DELETE":
        return True, t("net.delete.does", lang, to=to), t("net.delete.may", lang)
    if method == "PUT":
        return True, t("net.put.does", lang, to=to), t("net.put.may", lang)
    if method == "PATCH":
        return True, t("net.patch.does", lang, to=to), t("net.patch.may", lang)
    return False, t("net.read.does", lang, to=to), t("net.read.may", lang)


_SQL_MARKS = ("drop table", "drop database", "drop schema", "drop index", "drop view", "truncate table", "delete from")
_FIND_BAD = {"-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"}


def _destructive(cmd: Cmd, lang: str) -> Optional[tuple]:
    program = _program(cmd)
    args = cmd.words[1:]
    if program in _RM:
        return _removal(program, args, lang)
    if program == "git":
        return _git(args, lang)
    if program in _KILL:
        return t("kill.does", lang, prog=_name(program)), t("kill.may", lang)
    if program in _MOVE or program in _COPY:
        paths = _targets(args)
        verb = t("move.verb", lang) if program in _MOVE else t("copy.verb", lang)
        what = (
            t("move.what", lang, src=_code(paths[0]), dst=_code(paths[-1]))
            if len(paths) >= 2
            else t("move.files", lang)
        )
        return t("move.does", lang, verb=verb, what=what), t("move.may", lang)
    if program in _DISK or program.startswith("mkfs"):
        return t("disk.does", lang, prog=_name(program)), t("disk.may", lang)
    if program in _SHRED:
        return t("shred.does", lang, prog=_name(program)), t("shred.may", lang)
    if program in _PERM:
        recursive = any(_lower(w) in ("-r", "--recursive", "/t", "/s", "-recurse") or (
            len(w.bare) > 1 and w.bare[0] == "-" and w.bare[1] != "-" and "r" in w.bare[1:].lower()) for w in args)
        if recursive:
            return t("perm.does", lang, prog=_name(program)), t("perm.may", lang)
    if program == "find" and any(_lower(w) in _FIND_BAD for w in args):
        return t("find.does", lang), t("find.may", lang)
    if program == "reg" and args and _lower(args[0]) == "delete":
        return t("generic.does", lang, why=_name("reg delete")), t("generic.may", lang)
    for w in cmd.words:
        low = " ".join(w.bare.lower().split())
        if any(mark in low for mark in _SQL_MARKS):
            return t("sql.does", lang), t("sql.may", lang)
    return None


def _redirect_text(cmds: list, lang: str) -> Optional[tuple]:
    for cmd in cmds:
        for op, target in cmd.redirects:
            if op not in (">", ">>") or target.lower() in _NULL_DEVICES:
                continue
            if op == ">":
                return t("redirect.overwrite.does", lang, path=_code(target)), t("redirect.overwrite.may", lang)
            return t("redirect.append.does", lang, path=_code(target)), t("redirect.append.may", lang)
    return None


# --- the short list of programs that are read-only ----------------------------------------------------------------------

_READ_ONLY = {
    "ls", "dir", "pwd", "cat", "head", "tail", "wc", "echo", "grep", "egrep", "fgrep", "which", "where", "whoami",
    "uname", "type", "stat", "diff", "cut", "basename", "dirname", "realpath", "du", "df",
}
# These change the system or write a file through an argument (`date -s`, `hostname NAME`, `uniq in out`, `tree -o f`,
# `file -C`), so they are read-only only bare, or with the flags listed here. Anything else is risky.
_BARE_ONLY = {"date", "hostname"}
# program -> (single-letter flags that may be clustered, long flags (exact names), letters that take a numeric value,
#             most positional arguments)
_FLAG_RULES = {
    "tree": ("adfilghpsuDFNQrtxnC", {"--dirsfirst", "--noreport", "--prune", "--du", "--si", "--inodes", "--device",
                                     "--nolinks", "--ignore-case", "--filesfirst", "--gitignore"}, "L", 99),
    "file": ("bikLhnNprszE", {"--brief", "--mime", "--mime-type", "--mime-encoding", "--keep-going", "--dereference",
                              "--no-dereference", "--no-pad", "--preserve-date", "--raw", "--special-files",
                              "--uncompress"}, "", 99),
    "uniq": ("cdDiu", set(), "", 1),  # a second positional argument is the OUTPUT file
}
_GIT_READ = {"status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog", "remote", "branch", "tag", "stash"}
_GIT_BAD_ARG = ("--output", "--ext-diff", "--textconv", "--no-index", "--exec", "--open-files", "--upload-pack", "--receive-pack",
                 "--force", "--delete", "--move", "--copy", "--set-upstream", "--unset-upstream", "--edit-description")


def _git_bad_arg(arg: str) -> bool:
    """A dangerous git option, also in git's abbreviated spelling (`--out=x` is `--output=x`)."""
    if arg in ("-o", "-f"):
        return True
    if not arg.startswith("--"):
        return False
    name = arg.split("=", 1)[0]
    return len(name) >= 3 and any(bad.startswith(name) for bad in _GIT_BAD_ARG)


def _flags_ok(program: str, args: list) -> bool:
    letters, longs, numeric, max_positional = _FLAG_RULES[program]
    positional = 0
    i = 0
    while i < len(args):
        a = args[i]
        i += 1
        if a == "--":
            positional += len(args) - i
            break
        if a.startswith("--"):
            if a not in longs:
                return False
        elif a.startswith("-") and len(a) > 1:
            for pos, ch in enumerate(a[1:]):
                if ch in numeric:
                    # takes a number: either glued (`-L2`) or the next argument
                    rest = a[2 + pos :]
                    if rest:
                        if not rest.isdigit():
                            return False
                    elif i < len(args) and args[i].isdigit():
                        i += 1
                    else:
                        return False
                    break
                if ch not in letters:
                    return False
        else:
            positional += 1
    return positional <= max_positional
_GIT_BRANCH_OK = {"-a", "-r", "-v", "-vv", "--list", "--all", "--remotes", "--show-current", "--verbose", "-l"}
_RG_BAD = ("--pre", "--hostname-bin", "--search-zip", "-z")


def _is_read_only(cmd: Cmd) -> bool:
    first = cmd.words[0].text
    if "/" in first or "\\" in first:
        return False  # a program given by path could be anything
    program = _program(cmd)
    args = cmd.words[1:]
    low = [_lower(w) for w in args]
    if program == "git":
        if not args or _is_opt(args[0]):
            return False
        sub = low[0]
        rest = low[1:]
        if sub not in _GIT_READ:
            return False
        if any(_git_bad_arg(a) for a in rest):
            return False
        # Exact spelling, not lower-cased: `-D` is not `-d`, and an abbreviation such as `--lis` is not on the list.
        exact = [w.bare for w in args[1:]]
        if sub == "branch":
            return all(a in _GIT_BRANCH_OK for a in exact)
        if sub == "tag":
            return all(a in ("-l", "--list") for a in exact)
        if sub == "remote":
            return all(a in ("-v", "--verbose") for a in exact)
        if sub == "stash":
            return exact == ["list"]
        return True
    if program == "rg":
        return not any(a.startswith(_RG_BAD) for a in low)
    if program == "find":
        return not any(a in _FIND_BAD for a in low)
    if program in _BARE_ONLY:
        return not args
    if program in _FLAG_RULES:
        return _flags_ok(program, [w.bare for w in args])  # exact case: `-C` is not `-c`
    return program in _READ_ONLY


# --- public ----------------------------------------------------------------------------------------------------------


def _verdict(level: str, kind: str, codes: list, does: Optional[str], may: Optional[str]) -> dict:
    return {
        "level": level,
        "kind": kind,
        "codes": codes,
        "does": _sentence(does) if does else None,
        "may": _sentence(may) if may else None,
    }


def classify(command: object, lang: Optional[str] = None) -> dict:
    """Classify one command line. `level` is `safe` or `risky`; `kind` is `safe`, `destructive`, `unknown`
    or `unparseable`. Anything that is not clearly read-only is risky."""
    lg = normalize_lang(lang) if lang else "en"
    if not isinstance(command, str) or not command.strip():
        return _verdict("risky", "unparseable", ["empty_program"], t("empty.does", lg), t("empty.may", lg))
    try:
        cmds = lex(command)
    except Unparseable as exc:
        reason = t(f"u.{exc.code}", lg)
        return _verdict("risky", "unparseable", [exc.code], t("unparseable.does", lg, reason=reason), t("unparseable.may", lg))
    except Exception:  # a bug in the tokenizer must never read as safe
        reason = t("u.too_long", lg)
        return _verdict("risky", "unparseable", ["internal"], t("unparseable.does", lg, reason=reason), t("unparseable.may", lg))

    net_first: Optional[tuple] = None
    for cmd in cmds:
        found = _destructive(cmd, lg)
        if found:
            return _verdict("risky", "destructive", ["destructive"], found[0], found[1])
        if _program(cmd) in _NET:
            destructive, does, may = _network(cmd.words[1:], _program(cmd), lg)
            if destructive:
                return _verdict("risky", "destructive", ["destructive"], does, may)
            net_first = net_first or (does, may)
    redirect = _redirect_text(cmds, lg)
    if redirect:
        return _verdict("risky", "destructive", ["destructive"], redirect[0], redirect[1])
    if net_first:
        return _verdict("risky", "unknown", ["network"], net_first[0], net_first[1])
    if all(_is_read_only(cmd) for cmd in cmds):
        return _verdict("safe", "safe", [], None, None)
    return _verdict("risky", "unknown", ["unknown_program"], t("unknown.does", lg), t("unknown.may", lg))
