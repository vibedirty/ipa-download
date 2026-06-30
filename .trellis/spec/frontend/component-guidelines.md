# Component Guidelines

> How components are built in this project.

---

## Overview

<!--
Document your project's component conventions here.

Questions to answer:
- What component patterns do you use?
- How are props defined?
- How do you handle composition?
- What accessibility standards apply?
-->

(To be filled by the team)

---

## Component Structure

<!-- Standard structure of a component file -->

(To be filled by the team)

---

## Props Conventions

<!-- How props should be defined and typed -->

(To be filled by the team)

---

## Styling Patterns

<!-- How styles are applied (CSS modules, styled-components, Tailwind, etc.) -->

(To be filled by the team)

### Feedback Surfaces

Use purpose-specific feedback surfaces instead of writing command status text into the main page layout:

- `AlertDialog` for command failures, validation blocks, and unsafe states that prevent the requested action.
- `ConfirmDialog` for destructive or session-changing decisions, such as switching the real `ipatool` login.
- `Toast` for successful completion and non-blocking status updates.
- Modal-local status text is allowed only for the active modal workflow, such as PTY login progress.

Do not show command errors in the top bar, search results, details table, or settings content. Those areas should keep their structural information stable while feedback appears through the shared surfaces above.

### Loading States

For Tauri commands that can take perceptible time, render the target view first and show a skeleton in the content area before invoking the command. Search results and app details/version loading should clear stale rows, set a view-specific loading state, wait for the next browser frame, and then call the backend command. Guard asynchronous responses with a request id when a newer request can supersede an older one.

### Tabular Data

Use semantic `<table>` markup for data grids where headers and row cells must align to the same column boundaries. Do not use separate `div`/CSS-grid header and row structures for these cases; proportional grid columns plus `auto` action columns can drift visually when content widths differ.

Good:

```tsx
<table>
  <colgroup>
    <col className="nameColumn" />
    <col className="statusColumn" />
    <col className="actionColumn" />
  </colgroup>
  <thead>
    <tr>
      <th scope="col">Name</th>
      <th scope="col">Status</th>
      <th scope="col" aria-label="Actions" />
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Example</td>
      <td>Ready</td>
      <td><button>Download</button></td>
    </tr>
  </tbody>
</table>
```

Bad:

```tsx
<div className="tableHead">
  <span>Name</span>
  <span>Status</span>
  <span />
</div>
<div className="tableRow">
  <span>Example</span>
  <span>Ready</span>
  <button>Download</button>
</div>
```

---

## Accessibility

<!-- A11y requirements and patterns -->

(To be filled by the team)

---

## Common Mistakes

<!-- Component-related mistakes your team has made -->

(To be filled by the team)
