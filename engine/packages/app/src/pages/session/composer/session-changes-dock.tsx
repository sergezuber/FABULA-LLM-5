// FABULA: per-turn changes bar above the composer (reference-client style «N files changed ·
// Review · Undo»). Undo uses the engine's built-in revert (git snapshot + message roll); after an
// undo the SessionRevertDock takes over with per-message restore.
import { Button } from "@mimo-ai/ui/button"
import { DockTray } from "@mimo-ai/ui/dock-surface"
import { useLanguage } from "@/context/language"

export function SessionChangesDock(props: {
  count: number
  busy?: boolean
  onReview: () => void
  onUndo: () => void
}) {
  const language = useLanguage()
  return (
    <DockTray data-component="session-changes-dock">
      <div class="pl-3 pr-2 py-1.5 flex items-center gap-2">
        <span class="shrink-0 text-13-regular text-text-strong cursor-default">
          {language.t(
            props.count === 1 ? "session.changesDock.summary.one" : "session.changesDock.summary.other",
            { count: props.count },
          )}
        </span>
        <div class="ml-auto shrink-0 flex items-center gap-1.5">
          <Button size="small" variant="ghost" onClick={props.onReview}>
            {language.t("session.changesDock.review")}
          </Button>
          <Button size="small" variant="secondary" disabled={props.busy} onClick={props.onUndo}>
            {language.t("session.changesDock.undo")}
          </Button>
        </div>
      </div>
      <div class="h-5" aria-hidden="true" />
    </DockTray>
  )
}
