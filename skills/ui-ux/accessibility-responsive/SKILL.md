---
name: accessibility-responsive
description: Make a UI accessible (WCAG AA) and responsive across breakpoints. Use when building or reviewing any web/app interface, when asked about a11y, contrast, keyboard navigation, screen readers, mobile layout, or responsive design.
---

# Accessibility & Responsive Layout

The non-negotiable layer under every interface. Distilled from the MIT
`ui-ux-pro-max-skill` accessibility checklist. Apply this to anything you build or review.

## When to use
Any interface work — proactively, not only when asked. Also when reviewing a design for
compliance, fixing contrast, or adapting a layout to mobile.

## Accessibility — WCAG 2.2 AA baseline
- **Contrast:** ≥ 4.5:1 for body text, ≥ 3:1 for large text (≥ 24px or 19px bold) and UI
  components/icons. Check actual hex pairs, don't eyeball.
- **Keyboard:** every interactive element reachable and operable by keyboard; visible focus
  states (never `outline: none` without a replacement); logical tab order.
- **Semantics:** real `<button>`/`<a>`/`<nav>`/headings, not clickable `<div>`s; label every
  input; `alt` on meaningful images, empty `alt` on decorative ones; ARIA only to fill gaps.
- **Motion:** honor `prefers-reduced-motion`; no content that flashes > 3×/sec.
- **Targets:** touch targets ≥ 24×24px (44×44 comfortable); don't rely on color alone to
  convey state — pair with icon/text.

## Responsive — mobile-first, content-out
- **Breakpoints:** design at 375 (mobile), 768 (tablet), 1024 (laptop), 1440 (desktop).
  Layout should also survive arbitrary widths between them.
- **Fluid first:** prefer `clamp()`, `min()`, `max()`, flexbox/grid auto-fit, and relative
  units over fixed pixel widths and hard media-query jumps.
- **Reflow:** content must reflow to a single column at 320px with no horizontal scroll and
  no loss of function (WCAG 1.4.10).
- **Touch vs pointer:** hover-only affordances need a tap/focus equivalent.

## Output format
When reviewing, return a checklist of pass/fail items with the specific selector or hex pair
and the fix. When building, bake these in from the start — don't bolt on later.

## Safety rules
Never disable focus outlines without a visible substitute. Never gate core functionality
behind hover or precise pointing. Accessibility is a correctness requirement, not a polish item.

## Example
Review finding: "Primary CTA `#7CC8FF` on white = 1.9:1 — fails AA. Tab skips the mobile
menu (`<div onclick>`). Fix: darken CTA to `#1564C0` (4.6:1); make the menu a `<button>` with
`aria-expanded`; add `:focus-visible` ring."
