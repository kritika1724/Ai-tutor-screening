const DIMENSIONS = [
  { key: "clarity", label: "Communication clarity" },
  { key: "warmth", label: "Warmth and rapport" },
  { key: "simplicity", label: "Ability to simplify" },
  { key: "patience", label: "Patience and coaching" },
  { key: "fluency", label: "English fluency" },
];

const CORE_QUESTIONS = [
  {
    id: "motivation",
    dimension: "warmth",
    prompt:
      "Tell me about a time you helped a child learn something that first felt difficult.",
    stretchPrompt:
      "Tell me about a time you helped a child who was frustrated or losing confidence. How did you adjust your tone and approach in the moment?",
    followUp:
      "What did you actually say or do that made the child feel supported in that moment?",
    noExperienceFollowUp:
      "That's okay. If you haven't had that exact experience yet, take the closest real example or tell me how you would support a child in that moment.",
  },
  {
    id: "fractions",
    dimension: "simplicity",
    prompt:
      "Imagine I am 9 years old and nervous about fractions. How would you explain what three-fourths means?",
    stretchPrompt:
      "Imagine I am 9 years old, nervous about fractions, and I keep saying fractions are scary and useless. How would you explain three-fourths so I feel calmer and truly understand it?",
    followUp:
      "Could you try that again using a very simple everyday example a child would recognize right away?",
    noExperienceFollowUp:
      "No problem. Just walk me through exactly how you would explain it to a nervous 9-year-old, using a simple everyday example.",
  },
  {
    id: "stuck_student",
    dimension: "patience",
    prompt:
      "A student says, 'I still don't get it,' after staring at a problem for five minutes. What do you do next?",
    stretchPrompt:
      "A student says, 'I still don't get it,' after five minutes, sounds frustrated, and the parent is watching nearby. What do you do in the next one to two minutes?",
    followUp:
      "What exact words would you use in the first 30 seconds so the student feels calm and ready to try again?",
    noExperienceFollowUp:
      "That's fine if it hasn't happened exactly like that. Tell me what you would say and do in the first minute with that student.",
  },
  {
    id: "confidence_repair",
    dimension: "clarity",
    prompt:
      "A child gives a wrong answer and starts to shut down. How would you correct the mistake without hurting their confidence?",
    stretchPrompt:
      "A child gives the wrong answer twice, then says, 'I'm just bad at math.' How would you correct the mistake and rebuild confidence without sounding like a lecture?",
    followUp:
      "How would you keep the correction short, clear, and encouraging instead of sounding like a lecture?",
    noExperienceFollowUp:
      "That's okay. Even if you haven't seen that exact situation, walk me through how you would respond to keep the child calm and engaged.",
  },
];

const TURN_SCHEMA = {
  name: "interview_turn",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["decision", "message", "signals", "nextQuestionVariant"],
    properties: {
      decision: {
        type: "string",
        enum: ["follow_up", "advance", "finish"],
      },
      message: {
        type: "string",
        description:
          "The exact words the interviewer should say next. Keep it natural, warm, and under 45 words.",
      },
      signals: {
        type: "array",
        maxItems: 3,
        items: { type: "string" },
      },
      nextQuestionVariant: {
        type: "string",
        enum: ["current", "base", "stretch"],
      },
    },
  },
};

const EVALUATION_SCHEMA = {
  name: "tutor_screen_assessment",
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "decision",
      "confidence",
      "summary",
      "recommendationHeadline",
      "strengths",
      "risks",
      "suggestedNextStep",
      "dimensions",
    ],
    properties: {
      decision: {
        type: "string",
        enum: ["advance", "hold", "do_not_advance"],
      },
      confidence: {
        type: "string",
        enum: ["low", "medium", "high"],
      },
      summary: { type: "string" },
      recommendationHeadline: { type: "string" },
      strengths: {
        type: "array",
        minItems: 2,
        maxItems: 4,
        items: { type: "string" },
      },
      risks: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: { type: "string" },
      },
      suggestedNextStep: { type: "string" },
      dimensions: {
        type: "array",
        minItems: 5,
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["key", "label", "score", "reasoning", "evidence"],
          properties: {
            key: {
              type: "string",
              enum: DIMENSIONS.map((dimension) => dimension.key),
            },
            label: { type: "string" },
            score: {
              type: "integer",
              minimum: 1,
              maximum: 5,
            },
            reasoning: { type: "string" },
            evidence: {
              type: "array",
              minItems: 1,
              maxItems: 2,
              items: { type: "string" },
            },
          },
        },
      },
    },
  },
};

const serializeTranscript = (transcript = []) =>
  transcript
    .map(
      (turn, index) =>
        `${index + 1}. ${turn.role === "assistant" ? "Interviewer" : "Candidate"}: ${turn.text}`
    )
    .join("\n");

const buildTurnInput = ({
  session,
  currentQuestion,
  nextQuestionBase,
  nextQuestionStretch,
  analysis,
  followUpLimitReached,
  transcriptSource,
  recommendedNextQuestionVariant,
}) => {
  const candidateName = session.candidate?.name || "the candidate";
  const transcript = serializeTranscript(session.transcript);

  return [
    "You are Cuemath's warm, professional AI interviewer.",
    "Your job is to run a short spoken screening focused on soft skills for tutoring children.",
    "Decide whether to ask one focused follow-up or move to the next core question.",
    "Be encouraging, never robotic, and keep the conversation flowing.",
    "This is an English interview. If the candidate switches languages, gently ask them to answer in English.",
    "If the candidate gives a genuinely strong answer, appreciate it briefly before moving on.",
    "If the candidate gives a strong answer and you advance, prefer the stretch version of the next question.",
    "Return JSON only.",
    "",
    `Candidate: ${candidateName}`,
    `Current core question (${currentQuestion.dimension}, ${currentQuestion.activeVariant}): ${currentQuestion.activePrompt}`,
    `Suggested fallback follow-up for this question: ${currentQuestion.followUp}`,
    `Suggested fallback if the candidate has no exact direct experience: ${currentQuestion.noExperienceFollowUp || "Invite the closest real example or a clear hypothetical answer."}`,
    `Next core question if you advance (base): ${nextQuestionBase ? nextQuestionBase.activePrompt : "No next question. Wrap up if you have enough signal."}`,
    `Next core question if you advance (stretch): ${nextQuestionStretch ? nextQuestionStretch.activePrompt : "No next question. Wrap up if you have enough signal."}`,
    `Recommended next question variant from heuristics: ${recommendedNextQuestionVariant}`,
    `Follow-up limit reached for this question: ${followUpLimitReached ? "yes" : "no"}`,
    `Latest transcript source: ${transcriptSource}`,
    `Latest answer word count: ${analysis.wordCount}`,
    `Latest answer sentence count: ${analysis.sentenceCount}`,
    `Latest answer is very short: ${analysis.isVeryShort ? "yes" : "no"}`,
    `Latest answer is very long: ${analysis.isVeryLong ? "yes" : "no"}`,
    `Latest answer shows empathy language: ${analysis.showsEmpathy ? "yes" : "no"}`,
    `Latest answer shows child-friendly examples: ${analysis.showsExample ? "yes" : "no"}`,
    `Latest answer shows stepwise structure: ${analysis.hasStepwiseStructure ? "yes" : "no"}`,
    `Latest answer is actionable: ${analysis.isActionable ? "yes" : "no"}`,
    `Latest answer says they lack direct experience: ${analysis.mentionsNoDirectExperience ? "yes" : "no"}`,
    `Latest answer still gives a usable hypothetical plan: ${analysis.offersHypotheticalPlan ? "yes" : "no"}`,
    `Latest answer strength: ${analysis.answerStrengthLabel}`,
    `Latest answer strength score: ${analysis.answerStrengthScore} out of 5`,
    `Strong answers so far: ${session.performance?.strongAnswers || 0}`,
    "",
    "Rules:",
    "- If the answer is vague, too short, or hard to understand and a follow-up is still allowed, ask one concrete follow-up.",
    "- If the candidate says they have not had that exact experience, do not push them to invent one. Invite the closest real example or a hypothetical step-by-step response.",
    "- If the answer rambles, acknowledge it briefly and redirect to the next question in one sentence.",
    "- If the answer is strong, appreciate it in a natural way like a good interviewer would.",
    "- If this was the final core question and the answer is usable, finish warmly.",
    "- Keep the spoken message under 45 words and end with a question unless finishing.",
    "- Never mention scores, rubrics, or internal reasoning.",
    "- Set nextQuestionVariant to current for follow_up or finish.",
    "- Set nextQuestionVariant to base or stretch only when you advance.",
    "",
    "Transcript so far:",
    transcript,
  ].join("\n");
};

const buildEvaluationInput = (session) => {
  const transcript = serializeTranscript(session.transcript);

  return [
    "Evaluate this Cuemath tutor screening conversation.",
    "Judge only soft skills: clarity, warmth, simplicity, patience, and English fluency.",
    "Use a 1-5 scale where 5 is excellent and 3 is acceptable but mixed.",
    "Use exact short quotes from the transcript as evidence. Do not invent wording.",
    "If evidence is thin because answers were short or unclear, say that in the reasoning.",
    "Be fair, specific, and recruiter-friendly.",
    "",
    "Decision meanings:",
    "- advance: strong enough to move to the next round",
    "- hold: mixed signal, worth human review or another short screen",
    "- do_not_advance: soft skills are not yet strong enough for the next round",
    "",
    "Transcript:",
    transcript,
  ].join("\n");
};

module.exports = {
  CORE_QUESTIONS,
  DIMENSIONS,
  EVALUATION_SCHEMA,
  TURN_SCHEMA,
  buildEvaluationInput,
  buildTurnInput,
  serializeTranscript,
};
