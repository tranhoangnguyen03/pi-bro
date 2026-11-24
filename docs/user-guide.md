# pi-bro user guide

Find help by goal at the [docs home](README.md).

- [Getting started](getting-started.md) — install and a first working example.
- [Command reference](reference/commands.md) — complete commands and controls.
- [Model settings and preferences](reference/settings.md).
- [Backend access, privacy and retention](reference/data-and-permissions.md).
- [Troubleshooting](reference/troubleshooting.md).

The sections below retain previous guide anchors so existing links and bookmarks still lead to the right task page. Detailed instructions have moved, not been removed.

## What Bro can explain

See [What Bro can explain](reference/commands.md#what-bro-can-explain).

## Commands

See [Commands](reference/commands.md#commands).

## Explanation modes

See [Explanation modes](features/explain.md#explanation-modes).

### Modal controls

See [Explanation modes](features/explain.md#explanation-modes).

## Guided Review

See [Guided Review](features/guided-review.md#guided-review).

## Bro Elevate — improve a task before sending it

See [Elevate: Discover → Select → Upgrade](features/elevate.md). Elevate does not execute a task or send it to the main agent. It helps find gaps, lets you approve suggestions, then offers a revised request. Elevate never edits your Pi draft; copy and paste the revision if you wish.

## Bro btw (side conversation)

See [Bro btw (side conversation)](features/btw.md#bro-btw-side-conversation).

## Bro advisor

See [Bro advisor](features/advisor.md#bro-advisor).

## Bro show

See [Bro show](features/show.md#bro-show).

### A slow session-create, traced

See [Bro show](features/show.md#bro-show).

### The shape of code before it exists

See [Bro show](features/show.md#bro-show).

### A layout that collapses at narrow widths

See [Bro show](features/show.md#bro-show).

## Bro in action

See [Bro in action](examples.md#bro-in-action).

### Assistant response

See [Bro in action](examples.md#bro-in-action).

### Local document

See [Bro in action](examples.md#bro-in-action).

### Before

See [the first example's walkthrough](examples.md#bro-in-action).

### After `/bro`

#### What happened

See [What happened](examples.md#what-happened).

#### What it means

See [What it means](examples.md#what-it-means).

#### What you should do next

See [What you should do next](examples.md#what-you-should-do-next).

### Before

See [the second example](examples.md#bro-in-action).

### After `/bro`

#### What happened

See [What happened](examples.md#what-happened-1).

#### What it means

See [What it means](examples.md#what-it-means-1).

#### What you should do next

See [What you should do next](examples.md#what-you-should-do-next-1).

### Before

See [the third example](examples.md#bro-in-action).

### After `/bro`

#### What happened

See [What happened](examples.md#what-happened-2).

#### What it means

See [What it means](examples.md#what-it-means-2).

#### What you should do next

See [What you should do next](examples.md#what-you-should-do-next-2).

## Explain pasted text

See [Explain pasted text](features/explain.md#explain-pasted-text).

## Explain a document

See [Explain a document](features/explain.md#explain-a-document).

## Explain a webpage

See [Explain a webpage](features/explain.md#explain-a-webpage).

## Check your setup

See [Check your setup](reference/troubleshooting.md#check-your-setup).

## Settings

See [Settings](reference/settings.md#settings).

## Backends: access and retention

See [Backends: access and retention](reference/data-and-permissions.md#backends-access-and-retention).

### Configuration precedence

See [Backends: access and retention](reference/data-and-permissions.md#backends-access-and-retention).

## Preferences

See [Preferences](reference/settings.md#preferences).

## Privacy and safety

See [Privacy and safety](reference/data-and-permissions.md#privacy-and-safety).

## Troubleshooting and current limits

See [Troubleshooting and current limits](reference/troubleshooting.md#troubleshooting-and-current-limits).

## Simplify modal

`/bro` and `/bro simplify` open the latest result or help without calling a model. Explain a source in plain words with `/simplify` (latest reply), `/text`, `/file` or `/url`. Draw recent conversation turns with `/show [n-turns] [query]` in the same window. `/copy`, `/clear` and `/help` work for both. With an empty composer, **R** retries the captured source, **M** changes the mode for this explanation only, and **O** opens a browser diagram when available. Only the latest result is saved, in private Pi session entries that stay out of the main model's context. See the [command reference](reference/commands.md#what-bro-can-explain) for direct and headless forms.

## Bro command discovery and Config navigation

The `/bro ` menu offers one `simplify` entry for both explanations and diagrams. Type `/bro simplify ` for source options or a prefix such as `/bro doc` to find other commands. `/bro config` starts with **Global** (default, Preferences editor, Doctor on demand) and **Features** (per-feature settings). Esc goes back.
