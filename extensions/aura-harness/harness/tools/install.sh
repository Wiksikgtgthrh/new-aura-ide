#!/usr/bin/env bash
# Harness installer — разводит канон обвязки по всем агентским клиентам.
#
# Канон (единственный источник правды):
#   ~/.agents/skills/<имя>/SKILL.md   — скиллы
#   ~/AGENTS.md                      — мастер-контракт (стиль, память, контур)
#   ~/.AGENTS.md                     — глобальные правила для Freebuff/Codebuff
#   ~/AGENTS-SUMMARY.md, ~/MEMORY.md — сводка и карта
#   ~/.config/mcp/mcp.json           — общий набор MCP-серверов
#
# Что делает: на каждого клиента кладёт junction <клиент>/skills -> ~/.agents/skills
# и глобальный файл правил (если его ещё нет). Ничего чужого не перезаписывает.
#
# Использование:
#   bash ~/.agent-harness/tools/install.sh            # установить/допоставить
#   bash ~/.agent-harness/tools/install.sh --check    # только отчёт
#   bash ~/.agent-harness/tools/install.sh --force    # перезаписать файлы правил
set -u

H="${HOME:-/c/Users/$USERNAME}"
CANON="$H/.agents/skills"
FP_GLOBAL="$H/.AGENTS.md"
MCP_SRC="$H/.config/mcp/mcp.json"
MODE="install"
FORCE=0
COPY=0
for a in "$@"; do
  case "$a" in
    --check) MODE="check" ;;
    --force) FORCE=1 ;;
    --copy) COPY=1 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "неизвестный аргумент: $a" >&2; exit 2 ;;
  esac
done

if [ ! -d "$CANON" ]; then
  echo "нет канона скиллов: $CANON" >&2
  exit 1
fi

# клиент | папка скиллов (от $H) | файл глобальных правил (от $H) | формат mcp
CLIENTS=(
  "freebuff||.AGENTS.md|"
  "zcode|.zcode/skills|.zcode/AGENTS.md|zcode"
  "opencode|.config/opencode/skills|.config/opencode/AGENTS.md|"
  "claude-code|.claude/skills|.claude/CLAUDE.md|"
  "codex|.codex/skills|.codex/AGENTS.md|"
  "gemini-cli|.gemini/skills|.gemini/GEMINI.md|"
  "cursor|.cursor/skills|.cursor/AGENTS.md|"
  "copilot|.copilot/skills|.copilot/copilot-instructions.md|"
  "crush|.config/crush/skills|.config/crush/CRUSH.md|"
  "pi|.pi/agent/skills|.pi/agent/AGENTS.md|"
)

win_path() { cygpath -w "$1" 2>/dev/null || printf '%s' "$1"; }
skill_count() { find "$1/" -maxdepth 3 -name SKILL.md 2>/dev/null | wc -l | tr -d ' '; }

link_skills() {           # $1 = абсолютный путь папки скиллов клиента
  local dst="$1"
  if [ -d "$dst" ] && [ ! -L "$dst" ]; then
    local n; n=$(skill_count "$dst")
    if [ "$n" = "0" ]; then
      rmdir "$dst" 2>/dev/null
    else
      echo "  skills  : своя папка ($n скиллов) — не трогаю"
      return 0
    fi
  fi
  if [ -L "$dst" ]; then
    local tgt; tgt=$(readlink -f "$dst" 2>/dev/null || readlink "$dst")
    if [ "$tgt" = "$(readlink -f "$CANON")" ]; then
      echo "  skills  : уже связано -> ~/.agents/skills"
    else
      echo "  skills  : ссылка на $tgt — не трогаю"
    fi
    return 0
  fi
  mkdir -p "$(dirname "$dst")"
  if [ "$MODE" = "check" ]; then
    echo "  skills  : НЕТ (связал бы с ~/.agents/skills)"
    return 0
  fi
  if cmd //c "mklink /J $(win_path "$dst") $(win_path "$CANON")" >/dev/null 2>&1; then
    echo "  skills  : связал -> ~/.agents/skills ($(skill_count "$CANON") шт.)"
  elif [ "$COPY" -eq 1 ]; then
    cp -r "$CANON" "$dst" 2>/dev/null && echo "  skills  : скопировал ($(skill_count "$dst") шт.)"
  else
    echo "  skills  : ОШИБКА junction (можно --copy, но это +$(( $(du -sm "$CANON" | cut -f1) )) МБ на клиента)"
  fi
}

write_rules() {           # $1 = файл правил, $2 = папка скиллов клиента или ""
  local f="$1" skills_rel="$2"
  if [ -f "$f" ] && [ "$FORCE" -ne 1 ]; then
    echo "  rules   : есть ($(wc -l <"$f" | tr -d ' ') строк) — не трогаю"
    return 0
  fi
  if [ "$MODE" = "check" ] && [ ! -f "$f" ]; then
    echo "  rules   : НЕТ ($f)"
    return 0
  fi
  mkdir -p "$(dirname "$f")"
  {
    sed -n '1,200p' "$FP_GLOBAL"
    echo
    echo "---"
    echo "Скиллы: \`${skills_rel:-~/.agents/skills}\` — канон \`~/.agents/skills\` ($(skill_count "$CANON") шт.)."
    echo "Память: \`~/AGENTS.md\` (контракт), \`~/AGENTS-SUMMARY.md\` (сводка), \`~/MEMORY.md\` (карта), \`~/Session-Context/\` (выжимки)."
    echo "Инструменты: \`~/.agent-harness/tools/\`."
  } > "$f"
  echo "  rules   : записал ($f)"
}

echo "канон: $CANON ($(skill_count "$CANON") скиллов) | режим: $MODE"
echo
for row in "${CLIENTS[@]}"; do
  IFS='|' read -r id sdir rfile mcp <<<"$row"
  echo "[$id]"
  [ -n "$sdir" ] && link_skills "$H/$sdir"
  [ -z "$sdir" ] && echo "  skills  : через аккаунт Freebuff (облако), локально не нужно"
  [ -n "$rfile" ] && write_rules "$H/$rfile" "${sdir:+~/$sdir}"
  case "$mcp" in
    zcode)
      # ZCode читает пользовательский MCP из ~/.agents/mcp.json (ключ mcpServers),
      # а нативный ~/.zcode/cli/config.json ждёт mcp.servers. Держим один источник —
      # ~/.agents/mcp.json: его же импортируют Claude Code / Codex / opencode.
      shared="$H/.agents/mcp.json"
      if [ -f "$shared" ]; then
        echo "  mcp     : ~/.agents/mcp.json уже есть — не трогаю"
      elif [ "$MODE" = "check" ]; then
        echo "  mcp     : НЕТ (~/.agents/mcp.json из ~/.config/mcp/mcp.json)"
      else
        cp "$MCP_SRC" "$shared" && echo "  mcp     : записал ~/.agents/mcp.json ($(grep -c '"command"' "$shared") серверов)"
      fi
      if [ -f "$H/.zcode/cli/config.json" ] && grep -q '"mcp"' "$H/.zcode/cli/config.json" 2>/dev/null; then
        echo "  mcp     : ВНИМАНИЕ — в ~/.zcode/cli/config.json есть свой mcp.servers, он перекрывает .agents/mcp.json"
      fi
      ;;
  esac
done
echo
echo "проверка: bash ~/.agent-harness/tools/install.sh --check"
