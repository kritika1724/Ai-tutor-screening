const DEFAULT_TEXT_MODELS = ["gpt-5.4-mini", "gpt-4o-mini"];
const DEFAULT_EVAL_MODELS = ["gpt-5.4-mini", "gpt-4o"];
const DEFAULT_TRANSCRIBE_MODELS = ["gpt-4o-mini-transcribe", "whisper-1"];

const OPENAI_API_URL = "https://api.openai.com/v1";

const isOpenAIConfigured = () => Boolean(process.env.OPENAI_API_KEY);

const unique = (values) => [...new Set(values.filter(Boolean))];

const buildCandidateModels = (preferredModel, fallbacks) =>
  unique([preferredModel, ...fallbacks]);

const buildHeaders = (extraHeaders = {}) => ({
  Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
  ...extraHeaders,
});

const extractResponseText = (payload) => {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  if (!Array.isArray(payload.output)) {
    return "";
  }

  return payload.output
    .flatMap((entry) => entry.content || [])
    .map((content) => {
      if (typeof content.text === "string") {
        return content.text;
      }

      if (typeof content.output_text === "string") {
        return content.output_text;
      }

      return "";
    })
    .join("\n")
    .trim();
};

const parseStructuredOutput = (payload) => {
  if (payload.output_parsed) {
    return payload.output_parsed;
  }

  const text = extractResponseText(payload)
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  if (!text) {
    throw new Error("Model returned an empty response.");
  }

  return JSON.parse(text);
};

const readErrorMessage = async (response) => {
  const fallback = `${response.status} ${response.statusText}`;

  try {
    const payload = await response.json();
    return payload.error?.message || fallback;
  } catch (error) {
    return fallback;
  }
};

const runStructuredResponse = async ({
  modelPreference,
  modelFallbacks,
  input,
  schemaConfig,
  temperature = 0.4,
  verbosity = "medium",
}) => {
  if (!isOpenAIConfigured()) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const candidates = buildCandidateModels(modelPreference, modelFallbacks);
  let lastError;

  for (const model of candidates) {
    try {
      const response = await fetch(`${OPENAI_API_URL}/responses`, {
        method: "POST",
        headers: buildHeaders({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          model,
          input,
          temperature,
          store: false,
          text: {
            verbosity,
            format: {
              type: "json_schema",
              name: schemaConfig.name,
              schema: schemaConfig.schema,
              strict: true,
            },
          },
        }),
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }

      const payload = await response.json();

      return {
        data: parseStructuredOutput(payload),
        model,
      };
    } catch (error) {
      lastError = new Error(`[${model}] ${error.message}`);
    }
  }

  throw lastError || new Error("No model candidates were available.");
};

const extensionForMimeType = (mimeType = "") => {
  if (mimeType.includes("webm")) {
    return "webm";
  }

  if (mimeType.includes("wav")) {
    return "wav";
  }

  if (mimeType.includes("mp4") || mimeType.includes("m4a")) {
    return "m4a";
  }

  if (mimeType.includes("mpeg")) {
    return "mp3";
  }

  return "audio";
};

const normalizeTranscript = (value = "") =>
  value
    .replace(/\s+/g, " ")
    .replace(/\u2019/g, "'")
    .trim();

const transcribeAudio = async ({
  audioBase64,
  mimeType,
  transcriptHint,
  prompt,
}) => {
  const normalizedHint = normalizeTranscript(transcriptHint || "");

  if (!audioBase64) {
    return {
      transcript: normalizedHint,
      source: normalizedHint ? "browser_hint" : "missing_audio",
      model: null,
    };
  }

  if (!isOpenAIConfigured()) {
    return {
      transcript: normalizedHint,
      source: normalizedHint ? "browser_hint" : "fallback_unavailable",
      model: null,
    };
  }

  const audioBuffer = Buffer.from(audioBase64, "base64");
  const fileExtension = extensionForMimeType(mimeType);
  const candidates = buildCandidateModels(
    process.env.OPENAI_TRANSCRIBE_MODEL,
    DEFAULT_TRANSCRIBE_MODELS
  );
  let lastError;

  for (const model of candidates) {
    try {
      const formData = new FormData();
      formData.append(
        "file",
        new Blob([audioBuffer], { type: mimeType || "audio/webm" }),
        `candidate-answer.${fileExtension}`
      );
      formData.append("model", model);

      if (prompt) {
        formData.append("prompt", prompt);
      }

      const response = await fetch(`${OPENAI_API_URL}/audio/transcriptions`, {
        method: "POST",
        headers: buildHeaders(),
        body: formData,
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }

      const payload = await response.json();
      const transcript = normalizeTranscript(payload.text || "");

      return {
        transcript: transcript || normalizedHint,
        source: transcript ? "openai" : normalizedHint ? "browser_hint" : "empty",
        model,
      };
    } catch (error) {
      lastError = new Error(`[${model}] ${error.message}`);
    }
  }

  if (normalizedHint) {
    return {
      transcript: normalizedHint,
      source: "browser_hint",
      model: null,
      warning: lastError?.message || null,
    };
  }

  throw lastError || new Error("Unable to transcribe audio.");
};

module.exports = {
  DEFAULT_EVAL_MODELS,
  DEFAULT_TEXT_MODELS,
  isOpenAIConfigured,
  runStructuredResponse,
  transcribeAudio,
};
