"""UI strings in English and Brazilian Portuguese. Fixed texts only: nothing here is produced by a model."""

from __future__ import annotations

import os
from typing import Any, Optional

DEFAULT = "en"
SUPPORTED = ("en", "pt-BR")


def normalize_lang(value: Any) -> str:
    """Map a locale-ish value (`pt`, `pt_BR`, `pt-br`, `en-US`) to a supported id; anything else is `en`."""
    if not isinstance(value, str):
        return DEFAULT
    low = value.strip().lower().replace("_", "-")
    if low == "pt" or low.startswith("pt-"):
        return "pt-BR"
    return DEFAULT


def _config_language() -> Optional[str]:
    """`display.language` from config.yaml, read directly and read-only (Hermes' own loaders create files)."""
    try:
        from pathlib import Path

        try:
            from hermes_cli.config import get_config_path  # pure path lookup

            path = Path(get_config_path())
        except Exception:
            path = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes")) / "config.yaml"
        if not path.is_file():
            return None
        from ruamel.yaml import YAML

        with open(path, "r", encoding="utf-8") as fh:
            data = YAML(typ="safe").load(fh)
        value = ((data or {}).get("display") or {}).get("language")
        return value if isinstance(value, str) else None
    except Exception:
        return None


def resolve_lang(explicit: Any = None) -> str:
    """An explicit value, else the Hermes display language, else the environment, else English."""
    if explicit:
        return normalize_lang(explicit)
    value = _config_language()
    if value:
        return normalize_lang(value)
    return normalize_lang(os.environ.get("HERMES_LANGUAGE") or os.environ.get("LANG", ""))


STRINGS: dict[str, dict[str, str]] = {
    "en": {
        # risk: removal
        "rm.none.does": "Deletes files or folders, with no recycle bin.",
        "rm.none.may": "Whatever is deleted only comes back from a backup or git.",
        "rm.folder.does": "Deletes the folder {path}{more} and everything inside it, with no recycle bin.",
        "rm.folder.may": "Every file inside is lost; they only come back from a backup or git.",
        "rm.file.does": "Deletes {path}{more}, with no recycle bin.",
        "more.one": " and 1 more item",
        "more.many": " and {n} more items",
        # risk: git
        "git.mirror.does": "Mirrors the local repository to the server (git push --mirror).",
        "git.mirror.may": "Branches and tags that only exist on the server are deleted.",
        "git.pushdel.does": "Deletes a branch or tag on the remote server (git push --delete).",
        "git.pushdel.may": "Anyone using that branch or tag loses the reference.",
        "git.force.does": "Rewrites git history on the server (force push).",
        "git.force.may": "It can erase other people's commits; the local copy alone cannot undo it.",
        "git.reset.does": "Discards all uncommitted changes and goes back to the given commit (git reset --hard).",
        "git.reset.may": "Work that was not committed is lost.",
        "git.clean.does": "Deletes the files git does not track (git clean).",
        "git.clean.may": "New uncommitted files disappear, with no recycle bin.",
        "git.discard.does": "Discards changes in files (git {sub}).",
        "git.discard.may": "Uncommitted changes in those files are lost.",
        "git.branchdel.does": "Deletes the branch {name}.",
        "git.branchdel.may": "Commits that only existed on it may be left without a reference.",
        "git.tagdel.does": "Deletes or overwrites the tag {name}.",
        "git.tagdel.may": "Anyone pointing at that tag loses the reference.",
        "git.stashdrop.does": "Deletes what was saved in the stash.",
        "git.stashdrop.may": "The saved changes are lost.",
        "git.rm.does": "Removes files from git and from disk (git rm).",
        "git.rm.may": "The files disappear from the working folder.",
        "git.history.does": "Rewrites git history (git {sub}).",
        "git.history.may": "Commits may disappear or change identifier.",
        # risk: network
        "net.to": " to {host}",
        "net.delete.does": "Sends DELETE{to}.",
        "net.delete.may": "It may delete data on the server, with no way to undo it from here.",
        "net.put.does": "Sends PUT{to}.",
        "net.put.may": "It may overwrite data on the server.",
        "net.patch.does": "Sends PATCH{to}.",
        "net.patch.may": "It may change data on the server.",
        "net.unknown.does": "Sends an HTTP request{to} with a method that cannot be read.",
        "net.unknown.may": "It may delete or overwrite data on the server.",
        # risk: misc
        "kill.does": "Ends processes ({prog}).",
        "kill.may": "Unsaved work in those programs is lost.",
        "move.verb": "Moves or renames",
        "copy.verb": "Copies",
        "move.files": "files",
        "move.does": "{verb} {what}, overwriting the destination if it already exists.",
        "move.may": "The file that was at the destination is lost.",
        "move.what": "{src} to {dst}",
        "redirect.overwrite.does": "Writes to {path}, erasing what is already there.",
        "redirect.overwrite.may": "The previous content of the file is lost.",
        "redirect.append.does": "Appends text to the end of {path}.",
        "redirect.append.may": "Changes a file that already exists.",
        "disk.does": "Writes or formats a disk or device ({prog}).",
        "disk.may": "Everything on the target disk or file may be lost for good.",
        "shred.does": "Overwrites or empties files so they cannot be recovered ({prog}).",
        "shred.may": "The content cannot be recovered.",
        "perm.does": "Changes permissions or owner of a whole folder tree ({prog}).",
        "perm.may": "Programs and people may lose access, or get access they should not have.",
        "find.does": "Deletes or runs commands on every file that find matches.",
        "find.may": "Many files may be deleted or changed at once.",
        "sql.does": "Contains SQL that deletes data (DROP, TRUNCATE or DELETE FROM).",
        "sql.may": "Deleted tables and records do not come back without a backup.",
        "generic.does": "Command classified as destructive: {why}.",
        "generic.may": "It may delete or overwrite data with no way to undo it.",
        # risk: not destructive but not known to be read-only
        "unknown.does": "Command Reactor does not recognise as read-only.",
        "unknown.may": "It may change files, run code or use the network; check it before approving.",
        "net.read.does": "Makes a network request{to}.",
        "net.read.may": "It reaches the internet; Reactor does not check the answer.",
        "unparseable.does": "Command Reactor cannot fully analyse ({reason}).",
        "unparseable.may": "It may delete or overwrite data without warning.",
        "empty.does": "No command to analyse.",
        "empty.may": "Nothing was checked, so it is treated as risky.",
        # unparseable reasons
        "u.too_long": "command too long to analyse",
        "u.control_char": "control character",
        "u.unicode": "invisible, bidirectional or look-alike Unicode character",
        "u.unclosed_quote": "quote left open",
        "u.line_continuation": "line continuation",
        "u.no_target": "redirection without a target",
        "u.command_substitution": "command substitution",
        "u.backtick": "backtick (command substitution or PowerShell escape)",
        "u.here_doc": "here-doc",
        "u.process_substitution": "process substitution",
        "u.parentheses": "subshell or expression in parentheses",
        "u.braces": "block in braces",
        "u.ansi_c_quote": "bash dollar-single-quote string",
        "u.locale_quote": "bash dollar-double-quote string",
        "u.ambiguous_escape": "escape that bash, PowerShell and cmd read differently",
        "u.reserved_word": "shell reserved word (if, for, while...) in place of the command",
        "u.source": "script run inside the shell itself (. or source)",
        "u.call_operator": "PowerShell call operator (&)",
        "u.ambiguous_quote": "single quotes with an operator that cmd reads outside them",
        "u.glued_program": "program glued to / , = or \\ (cmd splits there)",
        "u.assignment_prefix": "variable assignment before the program",
        "u.assignment_only": "variable assignment with no program",
        "u.empty_program": "empty program",
        "u.expansion": "variable or %VAR% expansion",
        "u.history_expansion": "history expansion (!) in place of the command",
        "u.glob_program": "wildcard in the program name",
        "u.multiline": "command on more than one line",
        "u.comment": "comment (#) that one shell reads and another does not",
        "u.quote_split": "quote followed by text (PowerShell splits it in two)",
        "u.escaped_space": "backslash before a space",
        "u.shell_payload": "script handed to another shell",
        "u.ambiguous_redirect": "redirection form that shells read differently",
        "u.arithmetic": "arithmetic expression",
        # continuation
        "cont.awaiting": "Nothing has run yet. A card is waiting in Reactor in Hermes Desktop: the person must read it and click Run. You cannot run it, approve it or read its result.",
        "cont.may": "The agent runs under its own permission settings and could edit files and run commands in that folder.",
        "ask.awaiting": "Nothing has been sent yet. A card is waiting in Reactor in Hermes Desktop: the person must read it and click Send. You cannot send it, approve it or read the reply.",
        "ask.may": "The other profile has its own tools and settings and may use them to answer.",
        "cont.does": "Would continue the {agent} session {title} in {folder}.",
        # setup
        "setup.preview": "Preview only. Nothing was written. Run again with --apply to apply.",
        "setup.applied": "Applied. Backup of the previous config: {backup}",
        "setup.created": "Applied. There was no config file, so a new one was created.",
        "setup.nochange": "Config already matches. Nothing to change.",
        "setup.header": "Reactor voice setup for {path}",
        "setup.change": "  {key}: {old} -> {new}",
        "setup.unverified": "  note: {what} is not verified (not found in Hermes source).",
        "setup.badphrase": "Wake phrase must be 2-40 letters, digits, spaces, apostrophes or hyphens.",
        "setup.badmodel.missing": "The wake model file was not found. Give the path of a file you own, for example --wake-model models/jarbas.tflite.",
        "setup.badmodel.badpath": "The wake model path is not valid.",
        "setup.badmodel.unreadable": "The wake model file could not be read.",
        "setup.badmodel.onnx": "Hermes' openwakeword engine runs TensorFlow Lite (.tflite) models only, and an ONNX model crashes its loader. Nothing was written. Convert the model to .tflite first.",
        "setup.badmodel.notflite": "That file is not a TensorFlow Lite model (.tflite). Nothing was written.",
        "setup.fail": "Could not write the config ({why}). The original file is untouched.",
    },
    "pt-BR": {
        "rm.none.does": "Apaga arquivos ou pastas, sem lixeira.",
        "rm.none.may": "O que for apagado só volta com backup ou git.",
        "rm.folder.does": "Apaga a pasta {path}{more} e tudo dentro, sem lixeira.",
        "rm.folder.may": "Todos os arquivos dentro se perdem; só voltam com backup ou git.",
        "rm.file.does": "Apaga {path}{more}, sem lixeira.",
        "more.one": " e mais 1 item",
        "more.many": " e mais {n} itens",
        "git.mirror.does": "Espelha o repositório local no servidor (git push --mirror).",
        "git.mirror.may": "Branches e tags que só existem no servidor são apagadas.",
        "git.pushdel.does": "Apaga uma branch ou tag no servidor remoto (git push --delete).",
        "git.pushdel.may": "Quem usa essa branch ou tag perde a referência.",
        "git.force.does": "Reescreve o histórico do git no servidor (force push).",
        "git.force.may": "Pode apagar commits de outras pessoas; não dá para desfazer só com a cópia local.",
        "git.reset.does": "Descarta todas as alterações não commitadas e volta ao commit indicado (git reset --hard).",
        "git.reset.may": "O trabalho que não foi commitado se perde.",
        "git.clean.does": "Apaga os arquivos que o git não acompanha (git clean).",
        "git.clean.may": "Arquivos novos não commitados somem, sem lixeira.",
        "git.discard.does": "Descarta alterações nos arquivos (git {sub}).",
        "git.discard.may": "As alterações não commitadas nesses arquivos se perdem.",
        "git.branchdel.does": "Apaga a branch {name}.",
        "git.branchdel.may": "Commits que só existiam nela podem ficar sem referência.",
        "git.tagdel.does": "Apaga ou sobrescreve a tag {name}.",
        "git.tagdel.may": "Quem aponta para essa tag perde a referência.",
        "git.stashdrop.does": "Apaga o que foi guardado no stash.",
        "git.stashdrop.may": "As alterações guardadas se perdem.",
        "git.rm.does": "Remove arquivos do git e do disco (git rm).",
        "git.rm.may": "Os arquivos somem da pasta de trabalho.",
        "git.history.does": "Reescreve o histórico do git (git {sub}).",
        "git.history.may": "Commits podem sumir ou mudar de identificador.",
        "net.to": " para {host}",
        "net.delete.does": "Envia DELETE{to}.",
        "net.delete.may": "Pode apagar dados no servidor, sem como desfazer daqui.",
        "net.put.does": "Envia PUT{to}.",
        "net.put.may": "Pode sobrescrever dados no servidor.",
        "net.patch.does": "Envia PATCH{to}.",
        "net.patch.may": "Pode alterar dados no servidor.",
        "net.unknown.does": "Envia uma requisição HTTP{to} com um método que não dá para ler.",
        "net.unknown.may": "Pode apagar ou sobrescrever dados no servidor.",
        "kill.does": "Encerra processos ({prog}).",
        "kill.may": "O trabalho não salvo nesses programas se perde.",
        "move.verb": "Move ou renomeia",
        "copy.verb": "Copia",
        "move.files": "arquivos",
        "move.does": "{verb} {what}, sobrescrevendo o destino se ele já existir.",
        "move.may": "O arquivo que estava no destino se perde.",
        "move.what": "{src} para {dst}",
        "redirect.overwrite.does": "Grava em {path}, apagando o que já estiver lá.",
        "redirect.overwrite.may": "O conteúdo anterior do arquivo se perde.",
        "redirect.append.does": "Acrescenta texto ao final de {path}.",
        "redirect.append.may": "Altera um arquivo que já existe.",
        "disk.does": "Grava ou formata um disco ou dispositivo ({prog}).",
        "disk.may": "Tudo no disco ou arquivo de destino pode se perder de vez.",
        "shred.does": "Sobrescreve ou esvazia arquivos de modo que não dá para recuperar ({prog}).",
        "shred.may": "O conteúdo não pode ser recuperado.",
        "perm.does": "Muda permissões ou dono de uma árvore inteira de pastas ({prog}).",
        "perm.may": "Programas e pessoas podem perder acesso, ou ganhar um acesso que não deviam ter.",
        "find.does": "Apaga ou executa comandos em todos os arquivos que o find encontrar.",
        "find.may": "Muitos arquivos podem ser apagados ou alterados de uma vez.",
        "sql.does": "Contém SQL que apaga dados (DROP, TRUNCATE ou DELETE FROM).",
        "sql.may": "Tabelas e registros apagados não voltam sem backup.",
        "generic.does": "Comando classificado como destrutivo: {why}.",
        "generic.may": "Pode apagar ou sobrescrever dados sem como desfazer.",
        "unknown.does": "Comando que o Reactor não reconhece como somente leitura.",
        "unknown.may": "Pode alterar arquivos, rodar código ou usar a rede; confira antes de aprovar.",
        "net.read.does": "Faz uma requisição de rede{to}.",
        "net.read.may": "Acessa a internet; o Reactor não confere a resposta.",
        "unparseable.does": "Comando que o Reactor não consegue analisar por inteiro ({reason}).",
        "unparseable.may": "Pode apagar ou sobrescrever dados sem aviso.",
        "empty.does": "Nenhum comando para analisar.",
        "empty.may": "Nada foi conferido, então é tratado como arriscado.",
        "u.too_long": "comando longo demais para analisar",
        "u.control_char": "caractere de controle",
        "u.unicode": "caractere Unicode invisível, bidirecional ou parecido com outro",
        "u.unclosed_quote": "aspas sem fechar",
        "u.line_continuation": "continuação de linha",
        "u.no_target": "redirecionamento sem destino",
        "u.command_substitution": "substituição de comando",
        "u.backtick": "crase (substituição de comando ou escape do PowerShell)",
        "u.here_doc": "here-doc",
        "u.process_substitution": "substituição de processo",
        "u.parentheses": "subshell ou expressão entre parênteses",
        "u.braces": "bloco entre chaves",
        "u.ansi_c_quote": "texto com cifrão e aspas simples do bash",
        "u.locale_quote": "texto com cifrão e aspas duplas do bash",
        "u.ambiguous_escape": "escape que bash, PowerShell e cmd leem de jeitos diferentes",
        "u.reserved_word": "palavra reservada do shell (if, for, while…) no lugar do comando",
        "u.source": "script executado no próprio shell (. ou source)",
        "u.call_operator": "operador de chamada do PowerShell (&)",
        "u.ambiguous_quote": "aspas simples com operador que o cmd lê fora delas",
        "u.glued_program": "programa grudado em / , = ou \\ (o cmd separa ali)",
        "u.assignment_prefix": "atribuição de variável antes do programa",
        "u.assignment_only": "só atribuição de variável, sem programa",
        "u.empty_program": "programa vazio",
        "u.expansion": "expansão de variável ou %VAR%",
        "u.history_expansion": "expansão de histórico (!) no lugar do comando",
        "u.glob_program": "curinga no nome do programa",
        "u.multiline": "comando em mais de uma linha",
        "u.comment": "comentário (#) que um shell lê e outro não",
        "u.quote_split": "aspas seguidas de texto (o PowerShell separa em dois argumentos)",
        "u.escaped_space": "barra invertida antes de espaço",
        "u.shell_payload": "script entregue a outro shell",
        "u.ambiguous_redirect": "forma de redirecionamento que os shells leem de jeitos diferentes",
        "u.arithmetic": "expressão aritmética",
        "cont.awaiting": "Nada rodou ainda. Um cartão espera no Reactor, no Hermes Desktop: a pessoa precisa ler e clicar em Rodar. Você não consegue rodar, aprovar nem ler o resultado.",
        "cont.may": "O agente roda sob as próprias configurações de permissão e poderia editar arquivos e rodar comandos nessa pasta.",
        "ask.awaiting": "Nada foi enviado ainda. Um cartão espera no Reactor, no Hermes Desktop: a pessoa precisa ler e clicar em Enviar. Você não consegue enviar, aprovar nem ler a resposta.",
        "ask.may": "O outro perfil tem ferramentas e configurações próprias e pode usá-las para responder.",
        "cont.does": "Continuaria a sessão do {agent} {title} em {folder}.",
        "setup.preview": "Só prévia. Nada foi gravado. Rode de novo com --apply para aplicar.",
        "setup.applied": "Aplicado. Backup da configuração anterior: {backup}",
        "setup.created": "Aplicado. Não havia arquivo de configuração, então um novo foi criado.",
        "setup.nochange": "A configuração já está assim. Nada a mudar.",
        "setup.header": "Configuração de voz do Reactor em {path}",
        "setup.change": "  {key}: {old} -> {new}",
        "setup.unverified": "  nota: {what} não foi verificado (não aparece no código do Hermes).",
        "setup.badphrase": "A frase de ativação deve ter de 2 a 40 letras, números, espaços, apóstrofos ou hifens.",
        "setup.badmodel.missing": "O arquivo do modelo de ativação não foi encontrado. Informe o caminho de um arquivo seu, por exemplo --wake-model modelos/jarbas.tflite.",
        "setup.badmodel.badpath": "O caminho do modelo de ativação não é válido.",
        "setup.badmodel.unreadable": "Não foi possível ler o arquivo do modelo de ativação.",
        "setup.badmodel.onnx": "O mecanismo openwakeword do Hermes roda só modelos TensorFlow Lite (.tflite), e um modelo ONNX derruba o carregador dele. Nada foi gravado. Converta o modelo para .tflite antes.",
        "setup.badmodel.notflite": "Esse arquivo não é um modelo TensorFlow Lite (.tflite). Nada foi gravado.",
        "setup.fail": "Não foi possível gravar a configuração ({why}). O arquivo original não foi alterado.",
    },
}


def t(key: str, lang: str = DEFAULT, /, **kwargs: Any) -> str:
    """Fixed text for `key` in `lang`, falling back to English, then to the key itself."""
    table = STRINGS.get(normalize_lang(lang), STRINGS[DEFAULT])
    text = table.get(key) or STRINGS[DEFAULT].get(key) or key
    if kwargs:
        try:
            return text.format(**kwargs)
        except (KeyError, IndexError, ValueError):
            return text
    return text
