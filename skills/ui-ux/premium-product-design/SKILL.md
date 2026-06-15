---
name: premium-product-design
description: Apply the final layer of polish that makes an interface read as premium and expensive rather than generic. Use after the structure works, when asked to make something feel high-end, refined, or "$1000 not $10", or to critique why a UI looks cheap.
---

# Premium Product Design

The difference between "functional" and "premium" is a small number of disciplined choices,
applied consistently. Distilled from the MIT `ui-ux-pro-max-skill` pre-delivery checklist.
Use this as the last pass, after layout and content are correct.

## When to use
Final polish pass; "make it feel premium/high-end"; diagnosing why a UI looks cheap or
template-y. Pair it with `ui-ux-pro-max` (system) and `accessibility-responsive` (correctness).

## What makes a UI read as premium
1. **Restraint.** One accent color, one type family, a tight spacing scale. Premium is what
   you remove. Generic UIs over-decorate.
2. **Consistent spacing rhythm.** A single base unit (4 or 8px) and a scale — no arbitrary
   13px gaps. Whitespace is generous and intentional.
3. **Real type hierarchy.** Clear jumps between display / heading / body / caption via a
   modular scale and weight, not just size. Tighten letter-spacing on large headings.
4. **Considered color.** Mostly neutrals with sparing accent. Avoid pure black (#000) — use
   a near-black; avoid pure gray fills — tint them toward the brand hue.
5. **Micro-interactions.** 150–300ms ease-out transitions on hover/press/appearance; subtle,
   never bouncy. State changes are felt, not announced.
6. **Depth done quietly.** Soft, low-opacity shadows or 1px borders for elevation — not heavy
   drop shadows or skeuomorphic gloss.
7. **Crisp icons.** A single consistent icon set, optically aligned. **Never emoji as icons.**
8. **Pixel hygiene.** Aligned edges, optical centering, no 1px misalignments, consistent
   corner radii, `cursor: pointer` on everything clickable.

## Pre-delivery checklist (block ship until all pass)
- [ ] No emoji used as functional icons
- [ ] All clickable elements show `cursor: pointer` and a hover/focus state
- [ ] Transitions are 150–300ms and respect reduced-motion
- [ ] Spacing follows one scale; no orphan magic numbers
- [ ] One accent color, ≤ 2 type families
- [ ] Consistent corner radius and border/shadow treatment
- [ ] Empty, loading, and error states are designed (not afterthoughts)
- [ ] Passes the `accessibility-responsive` checklist

## Output format
A short "premium pass" diff: list what you changed and why, then the code. When critiquing,
name the specific cheapness tells and the one-line fix for each.

## Safety rules
Polish never overrides accessibility or the user's brand. Don't add motion that harms
usability or violates reduced-motion preferences.
