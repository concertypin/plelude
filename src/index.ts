/**
 * Library entry for plelude. The CLI lives at `plelude` (the bin); these are the pieces it is built from.
 *
 * - Plan a request: {@link planAsk}, {@link classifyMedia}
 * - Config and keys: {@link resolveApiKey}, {@link readConfigFile}, {@link updateConfigFile}
 * - Run an analysis: {@link resolveMedia}, {@link buildParams}, {@link streamAnalysis}, {@link createGeminiPort}
 */
export {
    parseTimestamp,
    planAsk,
    type AskInput,
    type AskPlan,
} from "@/core/options";
export { classifyMedia, mimeTypeFor, type MediaSource } from "@/core/media";
export {
    readConfigFile,
    resolveApiKey,
    updateConfigFile,
    type PluginConfig,
} from "@/core/config";
export {
    buildInput,
    buildParams,
    resolveMedia,
    streamAnalysis,
    AnalysisError,
    type AnalysisEvent,
    type ResolvedMedia,
} from "@/core/analyze";
export {
    createGeminiPort,
    type GeminiPort,
    type InteractionParams,
    type InputPart,
} from "@/core/gemini";
