import { classifyMedia, type MediaSource } from "@/core/media";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const PROCESSING_MODES = ["agentic", "static"] as const;
export type ProcessingMode = (typeof PROCESSING_MODES)[number];

export const THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const RESOLUTIONS = ["low", "medium", "high"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

/**
 * `ask` options exactly as the command line provided them, before validation.
 */
export interface AskInput {
    question?: string | undefined;
    media: readonly string[];
    continueFrom?: string | undefined;
    model?: string | undefined;
    mode?: string | undefined;
    start?: string | undefined;
    end?: string | undefined;
    fps?: number | undefined;
    thinkingLevel?: string | undefined;
    resolution?: string | undefined;
    system?: string | undefined;
    maxTokens?: number | undefined;
    ephemeral?: boolean | undefined;
    grounding?: boolean | undefined;
}

/**
 * A validated `ask` request, ready to be sent to Gemini.
 */
export interface AskPlan {
    question: string;
    sources: readonly MediaSource[];
    continueFrom: string | undefined;
    model: string | undefined;
    mode: ProcessingMode;
    clip: {
        startSec: number | undefined;
        endSec: number | undefined;
        fps: number | undefined;
    };
    thinkingLevel: ThinkingLevel | undefined;
    resolution: Resolution | undefined;
    system: string | undefined;
    maxTokens: number | undefined;
    ephemeral: boolean;
    grounding: boolean;
}

const fail = (error: string): { ok: false; error: string } => ({
    ok: false,
    error,
});

/**
 * Parses a time offset given as seconds (`90`, `90.5`), `MM:SS`, or `HH:MM:SS`.
 *
 * @returns Seconds, or `undefined` when the text is not a valid offset.
 */
export function parseTimestamp(input: string): number | undefined {
    const number = /^\d+(\.\d+)?$/;
    if (number.test(input)) return Number(input);
    const parts = input.split(":");
    if (
        parts.length < 2 ||
        parts.length > 3 ||
        !parts.every((part) => number.test(part))
    )
        return undefined;
    return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

function parseEnum<const T extends string>(
    value: string | undefined,
    allowed: readonly T[],
    flag: string
): Result<T | undefined> {
    if (value === undefined) return { ok: true, value: undefined };
    const found = allowed.find((item) => item === value);
    return found === undefined
        ? fail(`invalid ${flag} "${value}" (expected ${allowed.join(", ")})`)
        : { ok: true, value: found };
}

/**
 * Validates `ask` options and turns them into an {@link AskPlan}. The first problem found is reported.
 */
export function planAsk(input: AskInput): Result<AskPlan> {
    const question = input.question?.trim();
    if (!question)
        return fail(
            "a question is required (positional argument, or - to read stdin)"
        );
    if (input.media.length === 0 && !input.continueFrom) {
        return fail(
            "at least one -m/--media is required unless -c/--continue is given"
        );
    }
    if (input.continueFrom && input.ephemeral) {
        return fail(
            "--ephemeral cannot be combined with -c: ephemeral sessions are not stored, so they cannot be continued"
        );
    }

    const sources: MediaSource[] = [];
    for (const raw of input.media) {
        const source = classifyMedia(raw);
        if (source.kind === "invalid")
            return fail(`invalid media "${raw}": ${source.reason}`);
        sources.push(source);
    }

    const mode = parseEnum(
        input.mode,
        ["agentic", "static"] as const,
        "--mode"
    );
    if (!mode.ok) return mode;
    const processing: ProcessingMode = mode.value ?? "agentic";

    const clipRequested =
        input.start !== undefined ||
        input.end !== undefined ||
        input.fps !== undefined;
    if (clipRequested && processing !== "static") {
        return fail(
            '--start, --end and --fps only apply with --mode static. For agentic, state the time range in the prompt instead (e.g. "focus on 01:20-03:00").'
        );
    }

    const startSec =
        input.start === undefined ? undefined : parseTimestamp(input.start);
    if (input.start !== undefined && startSec === undefined) {
        return fail(
            `invalid --start "${input.start}" (use seconds, MM:SS, or HH:MM:SS)`
        );
    }
    const endSec =
        input.end === undefined ? undefined : parseTimestamp(input.end);
    if (input.end !== undefined && endSec === undefined) {
        return fail(
            `invalid --end "${input.end}" (use seconds, MM:SS, or HH:MM:SS)`
        );
    }
    if (startSec !== undefined && endSec !== undefined && startSec >= endSec) {
        return fail("--start must be earlier than --end");
    }
    if (input.fps !== undefined && !(input.fps > 0)) {
        return fail("--fps must be greater than 0");
    }
    if (
        input.maxTokens !== undefined &&
        !(Number.isInteger(input.maxTokens) && input.maxTokens > 0)
    ) {
        return fail("--max-tokens must be a positive integer");
    }

    const thinking = parseEnum(
        input.thinkingLevel,
        THINKING_LEVELS,
        "--thinking-level"
    );
    if (!thinking.ok) return thinking;
    const resolution = parseEnum(input.resolution, RESOLUTIONS, "--resolution");
    if (!resolution.ok) return resolution;

    return {
        ok: true,
        value: {
            question,
            sources,
            continueFrom: input.continueFrom,
            model: input.model,
            mode: processing,
            clip: { startSec, endSec, fps: input.fps },
            thinkingLevel: thinking.value,
            resolution: resolution.value,
            system: input.system,
            maxTokens: input.maxTokens,
            ephemeral: input.ephemeral ?? false,
            grounding: input.grounding ?? false,
        },
    };
}
