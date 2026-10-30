/**
 * Home title — Ember Duotone (the option that shipped).
 *
 * This page used to compare four presets. Option 03 was chosen, so it is now the
 * only one left here — it is also what WelcomePanel renders, which makes this
 * page the place to check the real thing in both themes.
 *
 * The controls stay: they drive the same props PixelHeading exposes, so you can
 * feel how cycleInterval / staggerDelay / mode change the character:
 *   · random   — at rest: golden-ratio split; animating: chars scramble alone
 *   · wave     — fonts flow left→right
 *   · multi    — staggered cascade
 *   · uniform  — whole word swaps family together
 */
import { useState } from 'react'
import { PixelHeading } from '@/components/ui/pixel-heading-character'

const MODES = ['random', 'wave', 'multi', 'uniform'] as const
type Mode = (typeof MODES)[number]

export function HomeTitleOptions() {
  const [mode, setMode] = useState<Mode>('random')
  const [cycle, setCycle] = useState(150)
  const [stagger, setStagger] = useState(50)
  const [auto, setAuto] = useState(false)

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-[1180px] px-8 pt-8 pb-14">
        <header className="mb-7">
          <h2 className="mb-1.5 text-[15px] font-semibold tracking-wide">
            Home hero title — Ember Duotone
          </h2>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            The shipped option. Same component, same props as{' '}
            <code className="rounded bg-secondary px-1.5 py-px font-mono text-[11.5px]">
              WelcomePanel
            </code>
            , so what you tune here is what production does. Hover or focus the
            title to run its cycle; the controls below drive the props live.
          </p>
        </header>

        <section className="relative overflow-hidden rounded-xl border border-border bg-card px-7 pt-6 pb-5">
          <span className="absolute inset-y-4 left-0 w-0.5 rounded bg-primary" />

          <div className="mb-4 flex items-baseline gap-2.5">
            <span className="font-mono text-[11px] font-bold tracking-widest text-primary">
              03
            </span>
            <span className="text-[13.5px] font-semibold">Ember Duotone</span>
            <span className="rounded bg-secondary px-1.5 py-px font-mono text-[11px] text-muted-foreground">
              {mode}
            </span>
            <span className="ml-auto font-mono text-[10.5px] tracking-wide text-muted-foreground">
              shipped
            </span>
          </div>

          <p className="mb-4 max-w-[74ch] text-[12px] leading-relaxed text-muted-foreground">
            Warm ember on the left, violet on the right. Characters scramble
            independently, so the heading reads as live data rather than a static
            logo. Deep and light themes each carry their own stops — the pastels
            that work on the dark canvas fall under 1.6:1 on light, so the light
            block deepens the same hues instead of reusing them.
          </p>

          {/* hero stage — mirrors WelcomePanel's layout */}
          <div className="flex items-start gap-4 py-3.5">
            <span className="mt-[11px] flex size-[46px] shrink-0 items-center justify-center rounded-xl bg-primary text-[22px] font-bold text-primary-foreground">
              R
            </span>
            <div className="min-w-0">
              <PixelHeading
                mode={mode}
                autoPlay={auto}
                cycleInterval={cycle}
                staggerDelay={stagger}
                className="px-title px-grad-ember text-[56px] leading-[1.14] font-medium tracking-[-0.012em]"
              >
                Keyper
              </PixelHeading>
              <p className="mt-1.5 text-[12.5px] text-muted-foreground">
                Redis desktop client
                <span className="mx-1.5 text-border">·</span>v1.0.0
                <span className="mx-1.5 text-border">·</span>Electron runtime
              </p>
            </div>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-dashed border-border pt-3.5 font-mono text-[11.5px] text-muted-foreground">
            <span>
              <b className="font-semibold text-secondary-foreground">fonts</b> 5
              Geist pixel families
            </span>
            <span>
              <b className="font-semibold text-secondary-foreground">gradient</b>{' '}
              #dc382d → #f4650f → #e5a13a → #f472b6 → #a78bfa
            </span>
            <span className="flex gap-1">
              {['#dc382d', '#f4650f', '#e5a13a', '#f472b6', '#a78bfa'].map((s) => (
                <i
                  key={s}
                  className="block size-3 rounded-sm"
                  style={{ background: s }}
                />
              ))}
            </span>
          </div>
        </section>

        <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-lg border border-border bg-card px-4 py-3 text-[12px] text-secondary-foreground">
          <label className="flex items-center gap-1.5">
            mode
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as Mode)}
              className="rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[11.5px]"
            >
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            cycle
            <input
              type="range"
              min={60}
              max={500}
              step={10}
              value={cycle}
              onChange={(e) => setCycle(Number(e.target.value))}
              className="w-24"
            />
            <span className="font-mono text-[11.5px]">{cycle}</span>
          </label>
          <label className="flex items-center gap-1.5">
            stagger
            <input
              type="range"
              min={0}
              max={200}
              step={10}
              value={stagger}
              onChange={(e) => setStagger(Number(e.target.value))}
              className="w-24"
            />
            <span className="font-mono text-[11.5px]">{stagger}</span>
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            auto play
          </label>
          <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">
            hover the title to animate
          </span>
        </div>
      </div>
    </div>
  )
}

export default HomeTitleOptions
