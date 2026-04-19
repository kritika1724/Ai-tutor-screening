const {
  createInterviewSession,
  getInterviewById,
  processInterviewAnswer,
} = require("../services/evaluationService");

const createInterview = async (req, res, next) => {
  try {
    const interview = await createInterviewSession(req.body || {});
    res.status(201).json(interview);
  } catch (error) {
    next(error);
  }
};

const getInterview = async (req, res, next) => {
  try {
    const interview = await getInterviewById(req.params.id);
    res.json(interview);
  } catch (error) {
    next(error);
  }
};

const submitInterviewAnswer = async (req, res, next) => {
  try {
    const result = await processInterviewAnswer(req.params.id, req.body || {});
    res.json(result);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createInterview,
  getInterview,
  submitInterviewAnswer,
};
