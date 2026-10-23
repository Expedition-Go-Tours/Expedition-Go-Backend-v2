# Supplier-Created Bookings — UI/UX Audit & Design Contract

Scope: what the supplier dashboard's design language actually IS (measured from
the code, not from memory), and the rules the Create-booking flow must obey so
it looks like it has always belonged there.

## 1. The design language, measured

### Colour
- **Brand green**: `#044b3b` (primary-500) / `#033629` (primary-600, hover).
  Every primary action in the app uses one of these two.
- **Surfaces**: `bg-white` cards on `bg-slate-50` page background; tinted
  surfaces use `bg-emerald-50`, borders `border-emerald-100/60`.
- **Text**: `slate-900` (headings), `slate-800` (values), `slate-700/600`
  (body/labels), `slate-500/400` (hints, metadata). Muted text is never below
  `slate-500` on white — the codebase has explicit contrast comments about
  `slate-400` being 2.6:1 and too low for labels.
- **States**: amber (`amber-50/200/600/700`) for warnings & pending, red
  (`red-50/200/600`) for destructive/errors, sky (`sky-500`) for neutral
  accents, emerald for success.

### Shape & elevation
- Cards & panels: `rounded-xl` with `border border-emerald-100/60` (bookings)
  or `border-slate-200` (finance/availability), `shadow-sm`.
- Inputs/buttons: `rounded-lg`; pills & avatars: `rounded-full`.
- Overlays: `rounded-xl`/`rounded-2xl` with `border border-slate-200` +
  `shadow-lg`/`shadow-2xl`.

### Type
- DM Sans (toasts set it explicitly; page inherits).
- Page title `text-xl sm:text-2xl font-bold text-slate-800/900`.
- Section headings `text-sm font-semibold text-slate-800`.
- Field labels `text-xs text-slate-500`; values `text-sm font-medium
  text-slate-800`; hints `text-[11px]/text-xs text-slate-400/500`.
- Numbers use `tabular-nums` where they stack.

### Form controls (the exact input recipe in use)
```
w-full px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-800
placeholder:text-slate-400 focus:outline-none focus:ring-2
focus:ring-emerald-500/20 focus:border-emerald-400
```
- Primary button: `bg-[#044b3b] text-white rounded-lg text-sm font-semibold
  hover:bg-[#033629] disabled:opacity-50` (or `bg-emerald-600/700`).
- Secondary: `border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-50`.
- Destructive: `border-red-200 text-red-600 hover:bg-red-50`.
- Icon buttons: `p-2 rounded-lg text-slate-500 hover:bg-slate-100`.

### Overlays
- `useModalDialog` is the required primitive: focus trap, Escape, focus returns
  to the trigger, `role="dialog" aria-modal="true" aria-labelledby`.
- Drawers (BookingDetailDrawer) = `fixed inset-0 z-50`, scrim
  `bg-slate-900/40`, right panel `w-full sm:max-w-xl h-full bg-white shadow-2xl`
  with a header (title + close) / scrollable body / sticky action bar.

### Feedback
- sonner toasts (`toast.success/error/warning`), `LoadingSpinner` +
  `animate-pulse` skeletons matching the eventual content's shape,
  `EmptyState`, inline `role="alert"` banners with `AlertTriangle` + Retry.
- Errors state what happened AND what it means ("nothing was changed").

### The existing wizard language (product builder)
`WizardSidebar` (step rail: completed / active / upcoming, progress),
`WizardNavFooter` (Back · Save & Continue · Submit; step validation with
inline errors; "Draft saved" state), `stepValidation.js` + `useStepErrors.js`,
per-step components in `steps/`. This is the app's multi-step pattern and the
Create-booking flow must look like a sibling of it.

## 2. What the feature must look like

- **Entry point**: a primary `Create booking` button in the Bookings header,
  beside Refresh — `bg-[#044b3b]`, `Plus` icon, `rounded-lg`, same height as
  Refresh. Gated on `bookings.manage`; hidden entirely when the flag is off.
- **Container**: a right-side drawer (max-w-2xl) reusing the BookingDetailDrawer
  chrome — not a new modal style. Four steps in a horizontal step rail matching
  `WizardSidebar` states (complete = green check, active = green ring, future =
  slate).
- **Steps**: Experience → Customer → Pricing & collection → Review. Each step
  is a `Section` with `text-sm font-semibold` headings and the standard field
  recipe. Availability uses the calendar language already in AvailabilityPage
  (amber = limited, red = full, slate = past).
- **Money**: every amount `font-semibold text-slate-900 tabular-nums`, labels
  `text-xs text-slate-500`. The collection step states plainly: "Recorded as
  collected — TravioAfrica does not verify offline payments."
- **Confirmation**: a success state inside the drawer (green check, booking
  reference in `font-mono`, the three states — reservation / platform payment /
  collected — each as a `StatusBadge`-style pill) with actions: View booking,
  Message customer, Done.
- **Cards & drawer**: an "Origin" pill (Marketplace / Supplier-created) next to
  the source badge, and a collection block ("Recorded as collected $400 ·
  Outstanding $0") using the existing Fact pattern.
- **Labels**: never "Total paid" for supplier-reported money — "Recorded as
  collected". Never "Paid" for an offline collection.

## 3. Rules this feature must not break
1. No new visual vocabulary: no new radii, shadows, fonts, or colour scales.
2. Every interactive element keyboard-reachable; the drawer traps focus.
3. `aria-*` on the wizard rail (`aria-current="step"`), the dialog, and status
   pills; `aria-live` for the price total as it recalculates.
4. Mobile: the drawer is full-width; the step rail collapses to a compact
   "Step 2 of 4" bar exactly as the product builder does.
5. Empty/loading/error states use the shared components, never bare text.
6. Destructive/financial actions (record collection, refund) require explicit
   confirmation, matching CancelBookingModal's two-step confirm.
7. Unsaved work warns before leaving (the builder's `useBlocker` pattern).

## 4. Verified against
`src/index.css` tokens, `WizardSidebar.jsx`, `WizardNavFooter.jsx`,
`BookingDetailDrawer.jsx`, `CancelBookingModal.jsx`, `useModalDialog.js`,
`LocationMapPicker.jsx`, `AvailabilityPage.jsx`, `FinancePage.jsx`.
