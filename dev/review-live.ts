import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openGuidedReview } from "../review-ui.ts";

// Development entry uses the production controller, not simulated answers.
export default function (pi: ExtensionAPI) {
	pi.registerCommand("review-live", {
		description: "Open the real Guided Review controller for a PR URL or resume",
		handler: (args, ctx) => openGuidedReview(ctx, args.trim(), ""),
	});
}
