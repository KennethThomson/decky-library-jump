# Library Jump

A [Decky Loader](https://decky.xyz) plugin for Steam Deck. Better library navigation, two ways: **hold a trigger (R2/L2)** to quickly step through your library on any sort, or **tap a trigger at the end of the list** to wrap to the other end.

## Functionality

Steam's R2/L2 moves one category at a time (i.e. one letter per step on A-Z) and does nothing additional when held. With Library Jump, holding R2/L2 keeps stepping at a steady pace:

- Steam's own big overlay label steps through the categories while you hold; the grid stays put (no covers loading for every category you pass).
- On release the grid scrolls once to the last category reached, with focus on its first game.
- Holding never wraps. Optionally, a tap at the end of the list wraps: R2 at the end jumps to the start, L2 at the start jumps to the end.

## Usage

Within your Steam library, hold R2 (forward) or L2 (back). Settings are in the Quick Access Menu (`...` button) under Library Jump:

| Setting | Meaning |
|---|---|
| Jump Speed | Time between steps while holding R2/L2, 150-450 ms. Lower is faster. |
| Wrap on Tap | Tap R2 at the end of the list to jump to the start, or L2 at the start to jump to the end. Holding never wraps. |

## How it works

The plugin runs in Steam's SharedJSContext and evaluates a small script inside the Big Picture window (found with `findSP()`), where Steam's library lives. The script captures the R2/L2 gamepad events, lets Steam's own section-jump handler do each step, repeats it while the button is held, defers scrolling until release, and finishes Steam's scroll animation early so steps can come quickly. Everything is found by shape (props, hooks, method names), never by minified names, and removed completely when the plugin unloads.

## Build

```bash
pnpm install
pnpm build
```

## Licence

MIT, see [LICENSE](LICENSE).
