const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const mongoose = require("mongoose");

const Interview = require("../models/Interview");
const {
  DEFAULT_EVAL_MODELS,
  DEFAULT_TEXT_MODELS,
  isOpenAIConfigured,
  runStructuredResponse,
  transcribeAudio,
} = require("./llmService");
const {
  CORE_QUESTIONS,
  DIMENSIONS,
  EVALUATION_SCHEMA,
  TURN_SCHEMA,
  buildEvaluationInput,
  buildTurnInput,
} = require("../utils/prompts");

const sessions = new Map();
const MAX_FOLLOW_UPS_PER_QUESTION = 1;
const INTERVIEW_ARCHIVE_DIR = path.join(__dirname, "..", "data", "interviews");

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const normalizeText = (value = "") => value.replace(/\s+/g, " ").trim();
const isValidEmail = (value = "") => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const now = () => new Date().toISOString();

const average = (values) => {
  if (!values.length) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const excerpt = (text = "", maxWords = 18) =>
  text
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .join(" ")
    .trim();

const analyzeAnswer = (text = "") => {
  const normalized = normalizeText(text);
  const words = normalized ? normalized.split(" ") : [];
  const lower = normalized.toLowerCase();
  const mentionsNoDirectExperience =
    /\b(i have not|i haven't|i dont have|i don't have|i never|not happened|hasn't happened|haven't faced|no direct experience|never had|didn't happen|did not happen)\b/.test(
      lower
    ) &&
    /\b(experience|situation|case|example|happened|faced|handled|taught|worked with)\b/.test(
      lower
    );
  const hasStepwiseStructure =
    /\b(first|then|next|finally|start by|step by step|i would)\b/.test(lower);
  const isActionable =
    /\b(ask|check|show|guide|break|pause|reassure|encourage|model|try)\b/.test(
      lower
    );
  const offersHypotheticalPlan =
    /\b(i would|i'd|i will|i can|my approach would be|i would start|i would first)\b/.test(
      lower
    );
  const showsEmpathy =
    /\b(feel|frustrat|normal|calm|reassure|encourage|safe|patient|listen|gentle)\b/.test(
      lower
    );
  const showsExample =
    /\b(example|like|imagine|pizza|cake|slice|share|piece|step by step)\b/.test(
      lower
    );

  const answerStrengthScore = clamp(
    (words.length >= 22 && words.length <= 95 ? 1 : 0) +
      (normalized && normalized.split(/[.!?]+/).filter(Boolean).length >= 2 ? 1 : 0) +
      (showsEmpathy ? 1 : 0) +
      (showsExample ? 1 : 0) +
      (hasStepwiseStructure || isActionable ? 1 : 0),
    0,
    5
  );

  const answerStrengthLabel =
    answerStrengthScore >= 4
      ? "strong"
      : answerStrengthScore >= 3
        ? "solid"
        : "developing";

  return {
    wordCount: words.length,
    sentenceCount: normalized
      .split(/[.!?]+/)
      .map((part) => part.trim())
      .filter(Boolean).length,
    isVeryShort: words.length < 18,
    isVeryLong: words.length > 110,
    mentionsNoDirectExperience,
    hasStepwiseStructure,
    isActionable,
    offersHypotheticalPlan,
    showsEmpathy,
    showsExample,
    answerStrengthScore,
    answerStrengthLabel,
  };
};

const getQuestionPrompt = (question, variant = "base") =>
  variant === "stretch" && question?.stretchPrompt ? question.stretchPrompt : question?.prompt;

const getQuestionForSession = (session, index) => {
  const question = CORE_QUESTIONS[index];

  if (!question) {
    return null;
  }

  const activeVariant = session.questionVariants?.[index] || "base";

  return {
    ...question,
    activeVariant,
    activePrompt: getQuestionPrompt(question, activeVariant),
  };
};

const buildOpeningMessage = (candidateName = "there") =>
  `Hi ${candidateName}, welcome to the Cuemath tutor screener. I’ll ask a few short spoken questions about how you explain ideas and support kids. Please answer in English. Let’s begin: ${getQuestionPrompt(CORE_QUESTIONS[0], "base")}`;

const buildAcknowledgment = (analysis) => {
  if (!analysis) {
    return "Thanks.";
  }

  if (analysis.answerStrengthLabel === "strong") {
    return analysis.showsExample
      ? "That was thoughtful and very child-friendly."
      : "That was a strong answer.";
  }

  if (analysis.answerStrengthLabel === "solid") {
    return "Nice, that was clear.";
  }

  return "Thanks.";
};

const buildClosingMessage = (analysis) =>
  normalizeText(
    `${buildAcknowledgment(analysis)} That gives me a solid sense of how you would teach and support a student. I’m wrapping up your assessment now.`
  );

const shouldUseStretchQuestion = (session, analysis) =>
  Boolean(
    analysis?.answerStrengthLabel === "strong" ||
      (analysis?.answerStrengthLabel === "solid" &&
        (session.performance?.strongAnswers || 0) >= 1)
  );

const nextQuestionMessage = (question, variant, analysis) =>
  normalizeText(
    `${buildAcknowledgment(analysis)} ${variant === "stretch" ? "Let's level it up a bit." : ""} ${getQuestionPrompt(question, variant)}`
  );

const noExperiencePivotMessage = (question, answerAnalysis) =>
  normalizeText(
    `${buildAcknowledgment(answerAnalysis)} ${
      question.noExperienceFollowUp ||
      "That's okay. Take the closest real example or tell me clearly how you would handle that situation."
    }`
  );

const followUpMessage = (question, answerAnalysis) => {
  if (answerAnalysis.isVeryLong) {
    return normalizeText(
      `${buildAcknowledgment(answerAnalysis)} Could you boil it down to the two things you would do first with the student?`
    );
  }

  return normalizeText(`${buildAcknowledgment(answerAnalysis)} ${question.followUp}`);
};

const getCandidateTurns = (session) =>
  session.transcript.filter((turn) => turn.role === "candidate");

const getCurrentQuestion = (session) =>
  getQuestionForSession(session, session.currentQuestionIndex);

const buildPublicInterview = (session) => ({
  id: session.id,
  status: session.status,
  candidate: session.candidate,
  progress: {
    current: Math.min(session.currentQuestionIndex + 1, CORE_QUESTIONS.length),
    total: CORE_QUESTIONS.length,
    followUpCountForCurrentQuestion: session.followUpCountForCurrentQuestion,
  },
  transcript: session.transcript,
  latestInterviewerMessage: session.latestInterviewerMessage,
  assessment: session.assessment,
  metadata: session.metadata,
  startedAt: session.startedAt,
  completedAt: session.completedAt,
});

const recordTurn = (session, turn) => {
  session.transcript.push({
    ...turn,
    timestamp: turn.timestamp || now(),
  });
};

const generateTurnWithLLM = async ({
  session,
  currentQuestion,
  nextQuestionBase,
  nextQuestionStretch,
  analysis,
  transcriptSource,
  recommendedNextQuestionVariant,
}) => {
  const result = await runStructuredResponse({
    modelPreference: process.env.OPENAI_TEXT_MODEL,
    modelFallbacks: DEFAULT_TEXT_MODELS,
    temperature: 0.6,
    input: [
      {
        role: "system",
        content:
          "You are a warm, concise AI interviewer for screening tutors. Always return valid JSON.",
      },
      {
        role: "user",
        content: buildTurnInput({
          session,
          currentQuestion,
          nextQuestionBase,
          nextQuestionStretch,
          analysis,
          followUpLimitReached:
            session.followUpCountForCurrentQuestion >= MAX_FOLLOW_UPS_PER_QUESTION,
          transcriptSource,
          recommendedNextQuestionVariant,
        }),
      },
    ],
    schemaConfig: TURN_SCHEMA,
  });

  return {
    ...result.data,
    model: result.model,
  };
};

const generateFallbackTurn = ({
  session,
  currentQuestion,
  nextQuestionBase,
  analysis,
  recommendedNextQuestionVariant,
}) => {
  const followUpLimitReached =
    session.followUpCountForCurrentQuestion >= MAX_FOLLOW_UPS_PER_QUESTION;

  if (!analysis.wordCount) {
    return {
      decision: "follow_up",
      message:
        "I could not clearly catch that answer. Could you say it once more in one or two clear sentences?",
      signals: ["audio_unclear"],
      nextQuestionVariant: "current",
      model: "fallback",
    };
  }

  if (
    analysis.mentionsNoDirectExperience &&
    !analysis.offersHypotheticalPlan &&
    !analysis.isActionable &&
    !followUpLimitReached
  ) {
    return {
      decision: "follow_up",
      message: noExperiencePivotMessage(currentQuestion, analysis),
      signals: ["pivoted_to_hypothetical"],
      nextQuestionVariant: "current",
      model: "fallback",
    };
  }

  if (
    (analysis.isVeryShort ||
      (!analysis.showsExample && currentQuestion.id === "fractions")) &&
    !followUpLimitReached
  ) {
    return {
      decision: "follow_up",
      message: followUpMessage(currentQuestion, analysis),
      signals: ["needs_specificity"],
      nextQuestionVariant: "current",
      model: "fallback",
    };
  }

  if (!nextQuestionBase) {
    return {
      decision: "finish",
      message: buildClosingMessage(analysis),
      signals: ["coverage_complete"],
      nextQuestionVariant: "current",
      model: "fallback",
    };
  }

  return {
    decision: "advance",
    message: nextQuestionMessage(
      nextQuestionBase,
      recommendedNextQuestionVariant,
      analysis
    ),
    signals:
      analysis.isVeryLong
        ? ["redirected_after_long_answer"]
        : recommendedNextQuestionVariant === "stretch"
          ? ["leveled_up_after_strong_answer"]
          : ["advance"],
    nextQuestionVariant: recommendedNextQuestionVariant,
    model: "fallback",
  };
};

const quoteCandidates = (session, patterns = []) => {
  const candidates = getCandidateTurns(session)
    .map((turn) => turn.text)
    .filter(Boolean);

  const matches = candidates.filter((text) =>
    patterns.some((pattern) => pattern.test(text.toLowerCase()))
  );

  const source = matches.length ? matches : candidates;

  return source.slice(0, 2).map((text) => excerpt(text));
};

const heuristicDimensionScore = (session, key) => {
  const answers = getCandidateTurns(session).map((turn) => turn.text);
  const allText = answers.join(" ").toLowerCase();
  const answerLengths = answers.map((answer) => analyzeAnswer(answer).wordCount);
  const avgWords = average(answerLengths);

  switch (key) {
    case "clarity":
      return clamp(
        3 +
          (/\b(first|then|because|so that|for example)\b/.test(allText) ? 1 : 0) -
          (avgWords < 16 || avgWords > 140 ? 1 : 0),
        1,
        5
      );
    case "warmth":
      return clamp(
        3 +
          (/\b(encourage|reassure|listen|calm|safe|comfortable|support)\b/.test(
            allText
          )
            ? 1
            : 0) +
          (/\b(feel|frustrated|nervous|confidence)\b/.test(allText) ? 1 : 0),
        1,
        5
      );
    case "simplicity":
      return clamp(
        2 +
          (/\b(pizza|cake|slice|share|piece|everyday|simple)\b/.test(allText)
            ? 2
            : 0) +
          (/\b(step by step|small example)\b/.test(allText) ? 1 : 0),
        1,
        5
      );
    case "patience":
      return clamp(
        3 +
          (/\b(pause|calm|reassure|check|smaller step|try again|breathe)\b/.test(
            allText
          )
            ? 1
            : 0) +
          (/\b(what do you understand|show me|where are you stuck)\b/.test(allText)
            ? 1
            : 0),
        1,
        5
      );
    case "fluency":
      return clamp(3 + (avgWords >= 22 ? 1 : 0) + (avgWords >= 40 ? 1 : 0), 1, 5);
    default:
      return 3;
  }
};

const heuristicReasoning = (key, score) => {
  const messages = {
    clarity:
      score >= 4
        ? "The candidate usually answers in a clear sequence and makes their teaching moves easy to follow."
        : "The candidate has the basics, but some answers stay general or need tighter structure.",
    warmth:
      score >= 4
        ? "The candidate repeatedly uses reassuring language and centers the child’s emotional experience."
        : "Warmth shows up at moments, but it is not yet consistently strong or specific.",
    simplicity:
      score >= 4
        ? "The candidate uses child-friendly examples and breaks concepts into simpler language."
        : "The candidate needs stronger concrete examples or simpler wording for younger learners.",
    patience:
      score >= 4
        ? "The candidate describes slowing down, checking understanding, and protecting confidence."
        : "The candidate talks about helping, but the step-by-step coaching response is still thin.",
    fluency:
      score >= 4
        ? "The candidate speaks fluently enough for a live tutoring setting."
        : "English communication is understandable but not consistently polished for a child-facing role.",
  };

  return messages[key];
};

const heuristicEvaluation = (session) => {
  const dimensions = DIMENSIONS.map((dimension) => {
    const score = heuristicDimensionScore(session, dimension.key);
    const evidenceMap = {
      clarity: [/\b(first|then|because|for example)\b/, /\b(explain|step)\b/],
      warmth: [/\b(feel|frustrated|nervous|confidence)\b/, /\b(encourage|reassure|support)\b/],
      simplicity: [/\b(pizza|cake|share|piece|simple|example)\b/],
      patience: [/\b(check|pause|try again|breathe|smaller step)\b/],
      fluency: [/.+/],
    };

    return {
      key: dimension.key,
      label: dimension.label,
      score,
      reasoning: heuristicReasoning(dimension.key, score),
      evidence: quoteCandidates(session, evidenceMap[dimension.key]),
    };
  });

  const overallScore = average(dimensions.map((dimension) => dimension.score));
  const decision =
    overallScore >= 4
      ? "advance"
      : overallScore >= 3
        ? "hold"
        : "do_not_advance";

  const sortedDimensions = [...dimensions].sort((left, right) => right.score - left.score);

  return {
    decision,
    confidence: getCandidateTurns(session).length >= 4 ? "medium" : "low",
    summary:
      decision === "advance"
        ? "The candidate shows enough warmth, clarity, and student-facing judgment to move forward."
        : decision === "hold"
          ? "The candidate shows promise, but the interview leaves a few soft-skill areas under-evidenced."
          : "The current conversation does not show enough child-facing communication strength for the next round.",
    recommendationHeadline:
      decision === "advance"
        ? "Move forward to the next tutor round."
        : decision === "hold"
          ? "Needs a human spot-check before advancing."
          : "Do not advance based on this screen.",
    strengths: sortedDimensions.slice(0, 2).map(
      (dimension) => `${dimension.label} looked strongest in this call.`
    ),
    risks: sortedDimensions.slice(-2).map(
      (dimension) => `${dimension.label} needs deeper evidence or stronger execution.`
    ),
    suggestedNextStep:
      decision === "advance"
        ? "Schedule the next round with a live teaching simulation."
        : decision === "hold"
          ? "Run a shorter human follow-up focused on simplification and patience."
          : "Share a polite rejection or invite re-application after more tutoring practice.",
    dimensions,
  };
};

const generateEvaluation = async (session) => {
  if (!isOpenAIConfigured()) {
    return heuristicEvaluation(session);
  }

  try {
    const result = await runStructuredResponse({
      modelPreference: process.env.OPENAI_EVAL_MODEL,
      modelFallbacks: DEFAULT_EVAL_MODELS,
      temperature: 0.2,
      input: [
        {
          role: "system",
          content:
            "You are a fair Cuemath recruiter evaluating a tutor screening transcript. Return valid JSON only.",
        },
        {
          role: "user",
          content: buildEvaluationInput(session),
        },
      ],
      schemaConfig: EVALUATION_SCHEMA,
    });

    return {
      ...result.data,
      model: result.model,
    };
  } catch (error) {
    return {
      ...heuristicEvaluation(session),
      warning: error.message,
    };
  }
};

const persistInterview = async (session) => {
  const archivePayload = {
    sessionId: session.id,
    candidate: session.candidate,
    status: session.status,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    metadata: session.metadata,
    transcript: session.transcript,
    assessment: session.assessment,
  };

  await fs.mkdir(INTERVIEW_ARCHIVE_DIR, { recursive: true });
  await fs.writeFile(
    path.join(INTERVIEW_ARCHIVE_DIR, `${session.id}.json`),
    JSON.stringify(archivePayload, null, 2)
  );

  if (mongoose.connection.readyState === 1) {
    await Interview.findOneAndUpdate(
      { sessionId: session.id },
      archivePayload,
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    );
  }
};

const createInterviewSession = async ({ candidateName, candidateEmail } = {}) => {
  const safeName = normalizeText(candidateName || "");
  const safeEmail = normalizeText(candidateEmail || "").toLowerCase();

  if (!safeName) {
    const error = new Error("Candidate name is required.");
    error.statusCode = 400;
    throw error;
  }

  if (!safeEmail || !isValidEmail(safeEmail)) {
    const error = new Error("A valid candidate email is required.");
    error.statusCode = 400;
    throw error;
  }

  const session = {
    id: crypto.randomUUID(),
    status: "active",
    candidate: {
      name: safeName,
      email: safeEmail,
    },
    transcript: [],
    currentQuestionIndex: 0,
    followUpCountForCurrentQuestion: 0,
    questionVariants: {
      0: "base",
    },
    performance: {
      strongAnswers: 0,
      solidAnswers: 0,
      developingAnswers: 0,
    },
    metadata: {
      llmEnabled: isOpenAIConfigured(),
      interviewMode: isOpenAIConfigured() ? "openai_guided" : "browser_fallback",
      adaptiveQuestioning: true,
      syntheticVoiceDisclosure:
        "The interviewer voice is synthesized. Candidate answers are spoken, then transcribed for scoring.",
    },
    startedAt: now(),
    completedAt: null,
    assessment: null,
    latestInterviewerMessage: "",
  };

  const openingMessage = buildOpeningMessage(safeName);

  recordTurn(session, {
    role: "assistant",
    text: openingMessage,
    questionId: CORE_QUESTIONS[0].id,
    turnType: "opening",
    metadata: {
      questionVariant: "base",
    },
  });

  session.latestInterviewerMessage = openingMessage;
  sessions.set(session.id, session);

  return buildPublicInterview(session);
};

const getInterviewById = async (interviewId) => {
  const session = sessions.get(interviewId);

  if (session) {
    return buildPublicInterview(session);
  }

  const archivedPath = path.join(INTERVIEW_ARCHIVE_DIR, `${interviewId}.json`);

  try {
    const archived = JSON.parse(await fs.readFile(archivedPath, "utf8"));
    return {
      id: archived.sessionId,
      status: archived.status,
      candidate: archived.candidate,
      progress: {
        current: CORE_QUESTIONS.length,
        total: CORE_QUESTIONS.length,
        followUpCountForCurrentQuestion: 0,
      },
      transcript: archived.transcript,
      latestInterviewerMessage:
        archived.transcript?.[archived.transcript.length - 1]?.text || "",
      assessment: archived.assessment,
      metadata: archived.metadata,
      startedAt: archived.startedAt,
      completedAt: archived.completedAt,
    };
  } catch (error) {
    const notFoundError = new Error("Interview session not found.");
    notFoundError.statusCode = 404;
    throw notFoundError;
  }
};

const processInterviewAnswer = async (interviewId, payload = {}) => {
  const session = sessions.get(interviewId);

  if (!session) {
    const notFoundError = new Error("Interview session not found.");
    notFoundError.statusCode = 404;
    throw notFoundError;
  }

  if (session.status === "completed") {
    return buildPublicInterview(session);
  }

  const transcription = await transcribeAudio({
    audioBase64: payload.audioBase64,
    mimeType: payload.mimeType,
    transcriptHint: payload.transcriptHint,
    prompt:
      "This is an English voice interview for screening a children’s math tutor. Prefer clear transcript text over filler words.",
  });

  const transcriptText = normalizeText(transcription.transcript);

  if (!transcriptText) {
    const retryMessage =
      "I could not clearly hear that answer. Please try once more in a quiet space and keep your response to a few clear sentences.";

    recordTurn(session, {
      role: "assistant",
      text: retryMessage,
      questionId: getCurrentQuestion(session).id,
      turnType: "repair",
      metadata: {
        transcriptSource: transcription.source,
      },
    });

    session.latestInterviewerMessage = retryMessage;

    return {
      ...buildPublicInterview(session),
      transcription: {
        text: "",
        source: transcription.source,
        model: transcription.model,
      },
    };
  }

  const currentQuestion = getCurrentQuestion(session);
  const nextQuestionBase = getQuestionForSession(
    session,
    session.currentQuestionIndex + 1
  );
  const nextQuestionStretch = nextQuestionBase
    ? {
        ...nextQuestionBase,
        activeVariant: "stretch",
        activePrompt: getQuestionPrompt(nextQuestionBase, "stretch"),
      }
    : null;

  recordTurn(session, {
    role: "candidate",
    text: transcriptText,
    questionId: currentQuestion.id,
    turnType: "answer",
    metadata: {
      durationMs: payload.durationMs || null,
      transcriptSource: transcription.source,
      transcriptionModel: transcription.model,
      questionVariant: currentQuestion.activeVariant,
    },
  });

  const analysis = analyzeAnswer(transcriptText);
  const recommendedNextQuestionVariant = nextQuestionBase
    ? shouldUseStretchQuestion(session, analysis)
      ? "stretch"
      : "base"
    : "current";

  if (analysis.answerStrengthLabel === "strong") {
    session.performance.strongAnswers += 1;
  } else if (analysis.answerStrengthLabel === "solid") {
    session.performance.solidAnswers += 1;
  } else {
    session.performance.developingAnswers += 1;
  }

  session.metadata.lastAnswerStrength = analysis.answerStrengthLabel;

  let turn;

  if (isOpenAIConfigured()) {
    try {
      turn = await generateTurnWithLLM({
        session,
        currentQuestion,
        nextQuestionBase,
        nextQuestionStretch,
        analysis,
        transcriptSource: transcription.source,
        recommendedNextQuestionVariant,
      });
    } catch (error) {
      turn = {
        ...generateFallbackTurn({
          session,
          currentQuestion,
          nextQuestionBase,
          analysis,
          recommendedNextQuestionVariant,
        }),
        warning: error.message,
      };
    }
  } else {
    turn = generateFallbackTurn({
      session,
      currentQuestion,
      nextQuestionBase,
      analysis,
      recommendedNextQuestionVariant,
    });
  }

  if (turn.decision !== "advance") {
    turn.nextQuestionVariant = "current";
  } else if (!["base", "stretch"].includes(turn.nextQuestionVariant)) {
    turn.nextQuestionVariant = recommendedNextQuestionVariant;
  }

  if (
    turn.decision === "follow_up" &&
    session.followUpCountForCurrentQuestion >= MAX_FOLLOW_UPS_PER_QUESTION
  ) {
    turn = nextQuestionBase
      ? {
          decision: "advance",
          message: nextQuestionMessage(
            nextQuestionBase,
            recommendedNextQuestionVariant,
            analysis
          ),
          signals: ["follow_up_limit_reached"],
          nextQuestionVariant: recommendedNextQuestionVariant,
          model: turn.model || "fallback",
        }
      : {
          decision: "finish",
          message: buildClosingMessage(analysis),
          signals: ["follow_up_limit_reached"],
          nextQuestionVariant: "current",
          model: turn.model || "fallback",
        };
  }

  if (!nextQuestionBase && turn.decision === "advance") {
    turn.decision = "finish";
    turn.message = buildClosingMessage(analysis);
    turn.nextQuestionVariant = "current";
  }

  if (turn.decision === "follow_up") {
    session.followUpCountForCurrentQuestion += 1;
  }

  if (turn.decision === "advance") {
    session.currentQuestionIndex += 1;
    session.followUpCountForCurrentQuestion = 0;
    session.questionVariants[session.currentQuestionIndex] = turn.nextQuestionVariant;
  }

  const assistantQuestionId =
    turn.decision === "advance" && nextQuestionBase
      ? nextQuestionBase.id
      : currentQuestion.id;
  const assistantQuestionVariant =
    turn.decision === "advance" && nextQuestionBase
      ? turn.nextQuestionVariant
      : currentQuestion.activeVariant;

  recordTurn(session, {
    role: "assistant",
    text: turn.message,
    questionId: assistantQuestionId,
    turnType: turn.decision,
    metadata: {
      model: turn.model || "fallback",
      signals: turn.signals || [],
      questionVariant: assistantQuestionVariant,
      answerStrengthSeen: analysis.answerStrengthLabel,
    },
  });

  session.latestInterviewerMessage = turn.message;

  if (turn.decision === "finish") {
    session.status = "completed";
    session.completedAt = now();
    session.assessment = await generateEvaluation(session);
    await persistInterview(session);
  }

  return {
    ...buildPublicInterview(session),
    transcription: {
      text: transcriptText,
      source: transcription.source,
      model: transcription.model,
      warning: transcription.warning || turn.warning || null,
    },
  };
};

module.exports = {
  createInterviewSession,
  getInterviewById,
  processInterviewAnswer,
};
