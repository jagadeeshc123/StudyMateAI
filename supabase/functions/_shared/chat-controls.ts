export type ResponseMode = "concise" | "balanced" | "detailed";

export interface ResponseModeConfig {
  minimumWords: number;
  maximumWords: number;
  presentation: string;
  citationTarget: string;
  maxSources: number;
  maxOutputTokens: number;
}

export const RESPONSE_MODES: Record<ResponseMode, ResponseModeConfig> = {
  concise: {
    minimumWords: 100,
    maximumWords: 180,
    presentation: "Give a direct answer with minimal explanation.",
    citationTarget: "Use 2-3 important citations when available.",
    maxSources: 3,
    maxOutputTokens: 300,
  },
  balanced: {
    minimumWords: 250,
    maximumWords: 400,
    presentation: "Give a clear explanation with key supporting details.",
    citationTarget: "Use 3-6 citations across the supporting material when available.",
    maxSources: 6,
    maxOutputTokens: 700,
  },
  detailed: {
    minimumWords: 500,
    maximumWords: 800,
    presentation: "Use a structured explanation covering definitions, relationships, supporting details, and limitations present in the document.",
    citationTarget: "Use 5-10 citations across relevant sections when available.",
    maxSources: 10,
    maxOutputTokens: 1_300,
  },
};

export function normalizeResponseMode(value: unknown): ResponseMode {
  return value === "concise" || value === "detailed" || value === "balanced"
    ? value
    : "balanced";
}

export function responseModeInstruction(mode: ResponseMode): string {
  const config = RESPONSE_MODES[mode];
  return [
    `Target ${config.minimumWords}-${config.maximumWords} words and do not exceed ${config.maximumWords} words.`,
    config.presentation,
    config.citationTarget,
    "Do not pad the answer when the document lacks enough support.",
  ].join(" ");
}

export function isCompleteDocumentIntent(question: string): boolean {
  const normalized = question.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  return [
    /\bsummari[sz]e (?:the )?(?:complete|entire|whole|full) (?:pdf|document)\b/,
    /\bsummari[sz]e (?:all|every) sections?\b/,
    /\bwhat (?:are )?the main topics\b/,
    /\bwhat is (?:this|the) (?:pdf|document) about\b/,
    /\b(?:give|provide) (?:me )?(?:an? )?overview\b/,
    /\bexplain (?:this|the) (?:pdf|document)\b/,
  ].some((pattern) => pattern.test(normalized));
}
