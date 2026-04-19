const mongoose = require("mongoose");

const transcriptTurnSchema = new mongoose.Schema(
  {
    role: { type: String, required: true },
    text: { type: String, required: true },
    timestamp: { type: Date, required: true },
    questionId: { type: String },
    turnType: { type: String },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const interviewSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    candidate: {
      name: { type: String, default: "Candidate" },
      email: { type: String, default: "" },
    },
    status: { type: String, default: "active" },
    startedAt: { type: Date, required: true },
    completedAt: { type: Date },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    transcript: { type: [transcriptTurnSchema], default: [] },
    assessment: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  {
    timestamps: true,
  }
);

module.exports =
  mongoose.models.Interview || mongoose.model("Interview", interviewSchema);
