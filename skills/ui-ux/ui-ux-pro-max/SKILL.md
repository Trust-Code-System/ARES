---
name: ui-ux-pro-max
description: Generate a complete, coherent UI/UX design system for a product — pattern, style, color palette, typography, motion, and anti-patterns — matched to the product type and industry. Use when designing or critiquing a landing page, dashboard, SaaS app, or mobile UI, or when asked to make something look premium/modern.
---

# UI/UX Pro Max — Design System Generation

A method for turning a vague "make it look good" into a defensible, coherent design
system. Distilled from the MIT `ui-ux-pro-max-skill` (a data-driven engine of 161
reasoning rules, 67 styles, 161 palettes, 57 type pairings). You don't have its CSVs;
you have its **method** — apply it with judgment.

## When to use
Designing or reviewing any visual interface: landing pages, dashboards, SaaS screens,
mobile apps, marketing sites. Also when the request is "make this premium/modern/clean".

## When NOT to use
Pure copywriting (use the marketing/writing skills), backend/architecture work, or when
the user has a locked design system you must follow exactly — then conform, don't redesign.

## Process — derive the system in order, never skip
1. **Classify the product.** Type (landing / dashboard / SaaS / mobile / e-commerce) and
   industry (fintech, healthtech, dev tools, consumer, B2B). Industry sets the emotional
   register: fintech = trust/precision; consumer = warmth/energy; dev tools = density/clarity.
2. **Pick ONE structural pattern.** e.g. hero→social-proof→features→pricing→CTA for a
   landing page; sidebar+topbar+content+detail for a dashboard. Commit to one; don't blend.
3. **Pick ONE style** and hold it everywhere: minimalist, glassmorphism, neumorphism,
   brutalist, editorial, etc. Mixing styles is the #1 amateur tell.
4. **Choose a palette** aligned to industry mood: 1 primary, 1 accent, a neutral ramp
   (4–6 grays), and semantic colors (success/warn/error). Limit to what you can name.
5. **Choose type** — a pairing (display + body) with clear personality and a modular
   scale (e.g. 1.25 ratio). One typeface family for body; never more than two families.
6. **Define motion** — 150–300ms transitions, ease-out for entrances, respect
   `prefers-reduced-motion`. Motion clarifies state; it is not decoration.
7. **List anti-patterns to avoid** for this product type, and check the output against them.

## Output format
Deliver a short **design system spec**: Pattern · Style · Palette (hex) · Type (families +
scale) · Spacing (base unit + scale) · Motion rules · 3–5 anti-patterns avoided. Then the
implementation. Keep tokens as CSS variables / Tailwind theme, not magic numbers.

## Safety rules
- Don't invent brand colors if the user has them — ask for or reuse the existing palette.
- Accessibility is non-negotiable: see the `accessibility-responsive` skill.
- Never ship emoji as functional icons.

## Example
Request: "Make my analytics dashboard look premium."
→ Type: dashboard / B2B SaaS. Pattern: persistent sidebar + sticky topbar + card grid +
slide-over detail. Style: minimalist with subtle depth (1px borders, soft shadows, no
gradients). Palette: indigo primary, slate neutrals, green/amber/red semantics. Type:
Inter 600 display / Inter 400 body, 1.25 scale. Spacing: 4px base, 8-point grid. Motion:
180ms ease-out on hovers and slide-overs. Anti-patterns avoided: rainbow charts, dense
unlabeled metrics, drop-shadow overload. (Hand to `premium-product-design` for final polish.)
