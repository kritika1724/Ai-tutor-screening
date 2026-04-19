const express = require("express");
const {
  createInterview,
  getInterview,
  submitInterviewAnswer,
} = require("../controllers/interviewController");

const router = express.Router();

router.post("/session", createInterview);
router.get("/:id", getInterview);
router.post("/:id/respond", submitInterviewAnswer);

module.exports = router;
