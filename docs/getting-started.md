# Getting started with Pi-bro

Pi-bro helps you understand agent replies, ask side questions, and review work without filling your main Pi conversation.

## 1. Install

You need **Pi**, Node.js 22.19.0 or later, and one supported backend CLI already installed and signed in (Agy, Claude, Grok, Codex, or Muse). See [requirements](../README.md#requirements).

```sh
pi install npm:pi-bro
```

Restart Pi (or run `/reload`). Then run:

```text
/bro doctor
```

**Expected:** A diagnostic view shows your selected backend, model, and any setup problems. This check does not prove that a live provider request will succeed. If it fails, [check your setup](reference/troubleshooting.md#check-your-setup).

## 2. Get your first result

Copy this complete command into Pi:

```text
/bro text A request limit means a service allows only a certain number of calls in a given time.
```

**Expected:** A Bro window opens and explains the sentence in simpler words. The exact answer depends on the backend. Use the arrow keys to scroll, **C** to copy, or **Esc** to close. Bro doesn't insert this result into your main agent's context.

This step makes a **real model call**, which may use your backend account's quota or incur charges.

## 3. Try the next useful command

| I want to… | Command |
| --- | --- |
| Understand the last agent answer | `/bro` (after the main agent has replied) |
| Ask a side question | `/bro btw What is a race condition?` |
| Visualize what we discussed | `/bro show` (after at least one user turn) |
| Explain a file in my workspace | `/bro file docs/my-report.md` (**replace with an existing path**) |
| Explain an actual public webpage | `/bro url https://your-public-page.example` (**replace with a real URL**) |

See the [docs home](README.md) for detailed workflows.

## Data and access before you use Bro at work

Bro sends your selected text and some context to the backend CLI and model provider you configure. BTW and the advisor have different access rules; some modes can read or change local files. Read [What leaves your machine](../README.md#what-leaves-your-machine) and the [backend access matrix](reference/data-and-permissions.md#backends-access-and-retention) before using private data. A model prompt saying 'do not access' is not a security boundary.
