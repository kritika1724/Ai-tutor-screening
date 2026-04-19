import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react'
import './App.css'

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

const SETUP_NOTES = [
  'The candidate should answer in English by speaking, not typing.',
  'This screen measures communication, warmth, patience, and fluency.',
  'Best experience: quiet room, Chrome or Edge, microphone enabled.',
]

const SETUP_SUMMARY = [
  { label: 'Interview style', value: 'Voice-led and adaptive' },
  { label: 'Question set', value: '4 core tutor scenarios' },
  { label: 'Output', value: 'Structured recruiter scorecard' },
]

const RUBRIC_PREVIEW = [
  'Communication clarity',
  'Warmth and rapport',
  'Ability to simplify',
  'Patience and coaching',
  'English fluency',
]

const LIVE_TIPS = [
  'If an answer is too short, the interviewer asks one focused follow-up.',
  'If the candidate rambles, the interviewer redirects gently.',
  'The scorecard includes evidence quotes for each dimension.',
]

const DIMENSION_HELP = {
  clarity: 'Is the explanation easy to follow?',
  warmth: 'Does the tutor sound encouraging and safe for kids?',
  simplicity: 'Can they explain ideas using simple language?',
  patience: 'Do they guide instead of rushing the student?',
  fluency: 'Is spoken English smooth enough for live sessions?',
}

const STATUS_COPY = {
  advance: 'Advance',
  hold: 'Needs review',
  do_not_advance: 'Do not advance',
}

const STATUS_STYLE = {
  advance: 'decision decision-advance',
  hold: 'decision decision-hold',
  do_not_advance: 'decision decision-stop',
}

const TRANSCRIPTION_SOURCE_LABELS = {
  openai: 'OpenAI speech-to-text',
  browser_hint: 'Browser transcript assist',
  fallback_unavailable: 'Fallback unavailable',
  missing_audio: 'Missing audio',
  empty: 'Empty transcript',
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const getBrowserSupport = () => {
  if (typeof window === 'undefined') {
    return {
      microphone: false,
      mediaRecorder: false,
      browserTranscript: false,
      speechSynthesis: false,
    }
  }

  return {
    microphone: Boolean(navigator.mediaDevices?.getUserMedia),
    mediaRecorder: typeof MediaRecorder !== 'undefined',
    browserTranscript: Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
    speechSynthesis: 'speechSynthesis' in window,
  }
}

const buildUrl = (path) => `${API_BASE_URL}${path}`

const requestJson = async (path, options = {}) => {
  let response

  try {
    response = await fetch(buildUrl(path), {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    })
  } catch {
    throw new Error(
      'Backend se connection nahi ho pa raha. Pehle backend start karo on port 5001, phir page refresh karke dubara try karo.',
    )
  }

  const rawText = await response.text()
  let payload = {}

  try {
    payload = rawText ? JSON.parse(rawText) : {}
  } catch {
    payload = {}
  }

  if (!response.ok) {
    const fallbackMessage =
      response.status === 404
        ? 'API route nahi mili. Agar frontend preview/static mode me chal raha hai to VITE_API_BASE_URL=http://127.0.0.1:5001 set karo.'
        : response.status === 500
          ? 'Backend pe server error aa raha hai. Backend terminal logs check karo.'
          : `Server request failed (${response.status}).`

    throw new Error(payload.message || fallbackMessage)
  }

  return payload
}

const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onloadend = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      resolve(result.split(',')[1] || '')
    }

    reader.onerror = () => reject(new Error('Could not read the recorded audio.'))
    reader.readAsDataURL(blob)
  })

const pickVoice = (voices) =>
  voices.find(
    (voice) =>
      /^en/i.test(voice.lang) &&
      /(samantha|moira|karen|zira|sonia|veena|female|google uk english female)/i.test(
        voice.name,
      ),
  ) ||
  voices.find((voice) => /^en/i.test(voice.lang)) ||
  null

const chooseRecorderOptions = () => {
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') {
    return undefined
  }

  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/mpeg',
  ]

  const mimeType = candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate))
  return mimeType ? { mimeType } : undefined
}

const formatTranscriptionSource = (source) =>
  TRANSCRIPTION_SOURCE_LABELS[source] || 'No transcript source yet'

const averageDimensionScore = (dimensions = []) => {
  if (!dimensions.length) {
    return null
  }

  const total = dimensions.reduce((sum, dimension) => sum + dimension.score, 0)
  return (total / dimensions.length).toFixed(1)
}

function App() {
  const [candidateName, setCandidateName] = useState('')
  const [candidateEmail, setCandidateEmail] = useState('')
  const [interview, setInterview] = useState(null)
  const [voices, setVoices] = useState([])
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [isStarting, setIsStarting] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [liveTranscript, setLiveTranscript] = useState('')
  const [error, setError] = useState('')
  const [support] = useState(() => getBrowserSupport())

  const deferredTranscript = useDeferredValue(liveTranscript)
  const mediaRecorderRef = useRef(null)
  const mediaStreamRef = useRef(null)
  const recognitionRef = useRef(null)
  const audioChunksRef = useRef([])
  const recordingStartedAtRef = useRef(0)
  const latestPromptSignatureRef = useRef('')
  const finalTranscriptRef = useRef('')
  const isRecordingRef = useRef(false)

  useEffect(() => {
    const updateVoices = () => {
      setVoices(window.speechSynthesis?.getVoices?.() || [])
    }

    updateVoices()
    window.speechSynthesis?.addEventListener?.('voiceschanged', updateVoices)

    return () => {
      window.speechSynthesis?.removeEventListener?.('voiceschanged', updateVoices)
      window.speechSynthesis?.cancel()
      if (recognitionRef.current) {
        recognitionRef.current.stop?.()
      }

      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop())
      }
    }
  }, [])

  useEffect(() => {
    if (!isRecording) {
      return undefined
    }

    const intervalId = window.setInterval(() => {
      setRecordingSeconds(Math.floor((Date.now() - recordingStartedAtRef.current) / 1000))
    }, 250)

    return () => window.clearInterval(intervalId)
  }, [isRecording])

  const selectedVoice = pickVoice(voices)

  const stopSpeech = () => {
    setIsSpeaking(false)
    window.speechSynthesis?.cancel()
  }

  const speakPrompt = (text) => {
    if (!support.speechSynthesis || !text) {
      return
    }

    stopSpeech()

    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = 0.98
    utterance.pitch = 1.02
    utterance.onstart = () => setIsSpeaking(true)
    utterance.onend = () => setIsSpeaking(false)
    utterance.onerror = () => setIsSpeaking(false)

    if (selectedVoice) {
      utterance.voice = selectedVoice
    }

    window.speechSynthesis.speak(utterance)
  }

  const autoSpeakPrompt = useEffectEvent((text) => {
    speakPrompt(text)
  })

  useEffect(() => {
    if (!interview?.latestInterviewerMessage) {
      return
    }

    const promptSignature = `${interview.id}:${interview.transcript.length}:${interview.latestInterviewerMessage}`

    if (promptSignature === latestPromptSignatureRef.current) {
      return
    }

    latestPromptSignatureRef.current = promptSignature
    autoSpeakPrompt(interview.latestInterviewerMessage)
  }, [interview?.id, interview?.latestInterviewerMessage, interview?.transcript.length])

  const cleanupRecorder = () => {
    isRecordingRef.current = false

    if (recognitionRef.current) {
      recognitionRef.current.onresult = null
      recognitionRef.current.onerror = null
      recognitionRef.current.onend = null

      try {
        recognitionRef.current.stop()
      } catch {
        // Ignore stop errors during teardown.
      }

      recognitionRef.current = null
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop())
      mediaStreamRef.current = null
    }

    mediaRecorderRef.current = null
    audioChunksRef.current = []
  }

  const startInterview = async () => {
    if (!trimmedCandidateName) {
      setError('Candidate name is required before starting the interview.')
      return
    }

    if (!isEmailValid) {
      setError('Please enter a valid email address before starting the interview.')
      return
    }

    setError('')
    setIsStarting(true)
    stopSpeech()

    try {
      const payload = await requestJson('/api/interviews/session', {
        method: 'POST',
        body: JSON.stringify({
          candidateName: trimmedCandidateName,
          candidateEmail: trimmedCandidateEmail,
        }),
      })

      startTransition(() => {
        setInterview(payload)
      })
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setIsStarting(false)
    }
  }

  const resetInterview = () => {
    cleanupRecorder()
    stopSpeech()
    setInterview(null)
    setCandidateName('')
    setCandidateEmail('')
    setLiveTranscript('')
    setRecordingSeconds(0)
    setError('')
    latestPromptSignatureRef.current = ''
    finalTranscriptRef.current = ''
  }

  const createSpeechRecognition = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition

    if (!SpeechRecognition) {
      return null
    }

    const recognition = new SpeechRecognition()
    recognition.lang = 'en-IN'
    recognition.interimResults = true
    recognition.continuous = true

    recognition.onresult = (event) => {
      let finalText = ''
      let interimText = ''

      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index]
        const segment = result[0]?.transcript?.trim()

        if (!segment) {
          continue
        }

        if (result.isFinal) {
          finalText += `${segment} `
        } else {
          interimText += `${segment} `
        }
      }

      finalTranscriptRef.current = finalText.trim()

      startTransition(() => {
        setLiveTranscript(`${finalText} ${interimText}`.trim())
      })
    }

    recognition.onerror = () => {
      // Browser speech recognition is a helper, not the source of truth.
    }

    recognition.onend = () => {
      if (!isRecordingRef.current) {
        return
      }

      try {
        recognition.start()
      } catch {
        // Ignore browser restart issues. Audio upload still continues.
      }
    }

    return recognition
  }

  const submitAnswer = async (audioBlob) => {
    if (!interview?.id) {
      return
    }

    setIsSubmitting(true)
    setError('')

    try {
      const audioBase64 = await blobToBase64(audioBlob)
      const payload = await requestJson(`/api/interviews/${interview.id}/respond`, {
        method: 'POST',
        body: JSON.stringify({
          audioBase64,
          mimeType: audioBlob.type || 'audio/webm',
          transcriptHint: liveTranscript || finalTranscriptRef.current,
          durationMs: recordingSeconds * 1000,
        }),
      })

      startTransition(() => {
        setInterview(payload)
      })
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setIsSubmitting(false)
      setLiveTranscript('')
      finalTranscriptRef.current = ''
      setRecordingSeconds(0)
    }
  }

  const startRecording = async () => {
    if (!interview || isSubmitting || !support.microphone || !support.mediaRecorder) {
      return
    }

    setError('')
    setLiveTranscript('')
    finalTranscriptRef.current = ''
    stopSpeech()

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      })

      mediaStreamRef.current = stream
      audioChunksRef.current = []

      const recorderOptions = chooseRecorderOptions()
      const recorder = new MediaRecorder(stream, recorderOptions)
      mediaRecorderRef.current = recorder
      isRecordingRef.current = true
      setIsRecording(true)
      recordingStartedAtRef.current = Date.now()
      setRecordingSeconds(0)

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }

      recorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, {
          type: recorder.mimeType || recorderOptions?.mimeType || 'audio/webm',
        })

        cleanupRecorder()
        await submitAnswer(audioBlob)
      }

      const recognition = createSpeechRecognition()
      recognitionRef.current = recognition

      recorder.start()

      if (recognition) {
        try {
          recognition.start()
        } catch {
          // Ignore recognition startup issues. The audio upload is still enough.
        }
      }
    } catch {
      cleanupRecorder()
      setIsRecording(false)
      setError('Microphone access was blocked. Please allow audio access and try again.')
    }
  }

  const stopRecording = () => {
    if (!mediaRecorderRef.current) {
      return
    }

    isRecordingRef.current = false
    setIsRecording(false)

    try {
      mediaRecorderRef.current.stop()
    } catch {
      cleanupRecorder()
      setError('The recording could not be stopped cleanly. Please try again.')
    }
  }

  const activeTranscript = interview?.transcript || []
  const candidateTurns = activeTranscript.filter((turn) => turn.role === 'candidate')
  const result = interview?.assessment
  const browserFallbackActive = interview?.metadata?.interviewMode === 'browser_fallback'
  const startDisabled =
    isStarting || !support.microphone || !support.mediaRecorder || isRecording || isSubmitting
  const recordingPreview =
    deferredTranscript || (isRecording ? 'Listening for your answer...' : 'No live transcript yet.')
  const progressPercent = interview
    ? (interview.progress.current / interview.progress.total) * 100
    : 0
  const lastCandidateTurn = candidateTurns[candidateTurns.length - 1]
  const lastTranscriptSource = formatTranscriptionSource(
    lastCandidateTurn?.metadata?.transcriptSource,
  )
  const scoreAverage = averageDimensionScore(result?.dimensions)
  const evidenceCount =
    result?.dimensions?.reduce((sum, dimension) => sum + dimension.evidence.length, 0) || 0
  const sessionModeLabel = browserFallbackActive ? 'Assisted interview mode' : 'AI interview active'
  const trimmedCandidateName = candidateName.trim()
  const trimmedCandidateEmail = candidateEmail.trim()
  const isEmailValid = EMAIL_PATTERN.test(trimmedCandidateEmail)
  const isCandidateFormValid = Boolean(trimmedCandidateName) && isEmailValid
  const promptPlaybackLabel = support.speechSynthesis
    ? isSpeaking
      ? 'Prompt is playing aloud'
      : 'Prompt appears on screen and plays aloud'
    : 'Prompt appears on screen'

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-copy">
          <p className="eyebrow">Cuemath Tutor Hiring</p>
          <h1>AI Tutor Screener</h1>
          <p className="header-subtitle">
            A clean, voice-first screening flow for evaluating tutor communication,
            warmth, patience, and clarity.
          </p>
        </div>

        <div className="header-badges">
          <span className="badge badge-accent">Voice Interview</span>
          <span className="badge">Soft Skills Focus</span>
          <span className="badge">Evidence-Based Scorecard</span>
        </div>
      </header>

      <main className="app-main">
        <section className="panel main-panel">
          {!interview && (
            <div className="panel-stack">
              <div className="section-intro">
                <p className="section-tag">Candidate Setup</p>
                <h2>Start a clean, professional screening experience</h2>
                <p>
                  The candidate speaks naturally, the interviewer responds with voice,
                  and the final output is a structured recruiter-ready recommendation.
                </p>
              </div>

              <section className="setup-overview">
                <div className="setup-overview-copy">
                  <p className="section-tag">Experience Design</p>
                  <h3>Questions appear on screen and are read aloud automatically</h3>
                  <p>
                    The flow is designed to feel calm, clear, and close to a real
                    tutoring interview rather than a generic form.
                  </p>
                </div>

                <div className="setup-summary-grid">
                  {SETUP_SUMMARY.map((item) => (
                    <article key={item.label} className="summary-card">
                      <p>{item.label}</p>
                      <strong>{item.value}</strong>
                    </article>
                  ))}
                </div>
              </section>

              <div className="form-grid">
                <label className="field">
                  <span>Candidate name</span>
                  <input
                    type="text"
                    value={candidateName}
                    onChange={(event) => setCandidateName(event.target.value)}
                    placeholder="Asha, Jordan, Priya..."
                  />
                </label>

                <label className="field">
                  <span>Email address</span>
                  <input
                    type="email"
                    value={candidateEmail}
                    onChange={(event) => setCandidateEmail(event.target.value)}
                    placeholder="candidate@example.com"
                  />
                </label>
              </div>

              {!trimmedCandidateName && (
                <p className="field-hint field-hint-error">Candidate name is required.</p>
              )}

              {trimmedCandidateEmail && !isEmailValid && (
                <p className="field-hint field-hint-error">
                  Enter a valid email address.
                </p>
              )}

              <div className="language-banner">
                Please answer in English throughout the interview.
              </div>

              <div className="toolbar">
                <button
                  className="primary-button"
                  onClick={startInterview}
                  disabled={startDisabled || !isCandidateFormValid}
                >
                  {isStarting ? 'Opening interview...' : 'Begin voice interview'}
                </button>

                <span className="voice-pill">
                  {support.speechSynthesis
                    ? 'Questions are spoken automatically'
                    : 'Text prompt mode'}
                </span>
              </div>

              <article className="inline-notes-panel">
                <p className="section-tag">Interview Notes</p>
                <div className="notes-grid">
                  {SETUP_NOTES.map((item) => (
                    <article key={item} className="info-card">
                      <p>{item}</p>
                    </article>
                  ))}
                </div>
              </article>

              {error && <div className="alert">{error}</div>}
            </div>
          )}

          {interview && interview.status !== 'completed' && (
            <div className="panel-stack">
              <div className="section-intro">
                <div className="section-row">
                  <div>
                    <p className="section-tag">Live Interview</p>
                    <h2>
                      {candidateName || interview.candidate?.name || 'Candidate'} is on question{' '}
                      {interview.progress.current} of {interview.progress.total}
                    </h2>
                    <p className="candidate-meta">
                      {interview.candidate?.email || candidateEmail}
                    </p>
                  </div>
                  <span className="badge">{sessionModeLabel}</span>
                </div>

                <p>
                  Each answer is transcribed, assessed, and used to decide whether to
                  follow up or move forward.
                </p>
              </div>

              <div className="stats-grid">
                <StatCard label="Progress" value={`${Math.round(progressPercent)}%`} />
                <StatCard
                  label="Answers captured"
                  value={String(candidateTurns.length).padStart(2, '0')}
                />
                <StatCard label="Transcript source" value={lastTranscriptSource} />
              </div>

              <div className="progress-track">
                <span className="progress-fill" style={{ width: `${progressPercent}%` }} />
              </div>

              <article className="prompt-panel">
                <div className="prompt-badge">AI</div>
                <div className="prompt-body">
                  <div className="prompt-head">
                    <p className="prompt-label">Current prompt</p>
                    <span className={isSpeaking ? 'badge badge-accent' : 'badge'}>
                      {isSpeaking ? 'Speaking now' : 'On screen'}
                    </span>
                  </div>
                  <p className="prompt-text">{interview.latestInterviewerMessage}</p>
                  <p className="prompt-note">{promptPlaybackLabel}. Please answer in English.</p>
                </div>
              </article>

              <div className="toolbar">
                <button
                  className={isRecording ? 'record-button active' : 'record-button'}
                  onClick={isRecording ? stopRecording : startRecording}
                  disabled={isSubmitting}
                >
                  <span className="record-dot" />
                  {isRecording ? `Stop answer (${recordingSeconds}s)` : 'Record spoken answer'}
                </button>

                {support.speechSynthesis && (
                  <button
                    className="secondary-button"
                    onClick={() => speakPrompt(interview.latestInterviewerMessage)}
                  >
                    Replay prompt
                  </button>
                )}
              </div>

              <article className="live-panel">
                <div className="live-panel-head">
                  <div>
                    <p className="prompt-label">Live transcript assist</p>
                    <p className="live-copy">{recordingPreview}</p>
                  </div>
                  {isRecording && <WaveBars />}
                </div>

                <div className="live-meta">
                  <span>{isRecording ? 'Listening now' : 'Ready for the next answer'}</span>
                  <span>{isSubmitting ? 'Transcribing and evaluating...' : 'Waiting'}</span>
                </div>
              </article>

              {browserFallbackActive && !support.browserTranscript && (
                <div className="alert">
                  Assisted interview mode is active, but browser speech recognition is not
                  available here. Add an AI key on the server or use Chrome or Edge for
                  the strongest demo.
                </div>
              )}

              {error && <div className="alert">{error}</div>}
            </div>
          )}

          {interview && interview.status === 'completed' && result && (
            <div className="panel-stack">
              <div className="section-intro">
                <div className="section-row">
                  <div>
                    <p className="section-tag">Final Assessment</p>
                    <h2>{result.recommendationHeadline}</h2>
                  </div>
                  <div className={STATUS_STYLE[result.decision] || STATUS_STYLE.hold}>
                    {STATUS_COPY[result.decision] || result.decision}
                  </div>
                </div>
                <p>{result.summary}</p>
              </div>

              <div className="stats-grid">
                <StatCard label="Average score" value={scoreAverage || '--'} />
                <StatCard label="Evidence quotes" value={String(evidenceCount)} />
                <StatCard label="Confidence" value={result.confidence} />
              </div>

              <div className="score-grid">
                {result.dimensions.map((dimension) => (
                  <article key={dimension.key} className="score-card">
                    <div className="score-head">
                      <div>
                        <p className="score-label">{dimension.label}</p>
                        <p className="score-help">{DIMENSION_HELP[dimension.key]}</p>
                      </div>
                      <strong>{dimension.score}/5</strong>
                    </div>

                    <div className="meter">
                      <span
                        className="meter-fill"
                        style={{ width: `${(dimension.score / 5) * 100}%` }}
                      />
                    </div>

                    <p className="score-reasoning">{dimension.reasoning}</p>

                    <div className="quote-stack">
                      {dimension.evidence.map((quote) => (
                        <blockquote key={quote} className="quote-card">
                          "{quote}"
                        </blockquote>
                      ))}
                    </div>
                  </article>
                ))}
              </div>

              <div className="insight-grid">
                <article className="list-card">
                  <p className="section-tag">Strengths</p>
                  <ul>
                    {result.strengths.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </article>

                <article className="list-card">
                  <p className="section-tag">Risks</p>
                  <ul>
                    {result.risks.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </article>
              </div>

              <article className="next-step-card">
                <p className="section-tag">Suggested next step</p>
                <p>{result.suggestedNextStep}</p>
              </article>

              <div className="toolbar">
                <button className="primary-button" onClick={resetInterview}>
                  Run another interview
                </button>
              </div>
            </div>
          )}
        </section>

        <aside className="sidebar">
          <section className="panel side-panel">
            <p className="section-tag">Evaluation Rubric</p>
            <div className="rubric-list">
              {RUBRIC_PREVIEW.map((item) => (
                <div key={item} className="rubric-item">
                  <span className="rubric-dot" />
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="panel side-panel">
            <p className="section-tag">System Status</p>
            <div className="status-list">
              <SupportRow
                label="Microphone"
                value={support.microphone && support.mediaRecorder ? 'Ready' : 'Missing'}
              />
              <SupportRow
                label="Browser transcript"
                value={support.browserTranscript ? 'Available' : 'Unavailable'}
              />
              <SupportRow
                label="Voice playback"
                value={support.speechSynthesis ? 'Ready' : 'Text only'}
              />
            </div>
          </section>
        </aside>

      </main>

      <section className="panel transcript-panel">
        <div className="section-row transcript-header">
          <div>
            <p className="section-tag">Transcript</p>
            <h2>Conversation history</h2>
          </div>
          {interview && <span className="badge">{candidateTurns.length} candidate answers</span>}
        </div>

        {!interview && (
          <p className="empty-copy">
            The transcript will appear here once the interview starts.
          </p>
        )}

        {interview && (
          <div className="timeline">
            {activeTranscript.map((turn, index) => (
              <article
                key={`${turn.timestamp}-${index}-${turn.role}`}
                className={turn.role === 'assistant' ? 'timeline-item assistant' : 'timeline-item candidate'}
              >
                <div className="timeline-badge">{turn.role === 'assistant' ? 'AI' : 'Tutor'}</div>
                <div className="timeline-body">
                  <p className="prompt-label">
                    {turn.role === 'assistant' ? 'Interviewer' : 'Candidate'}
                  </p>
                  <p className="turn-text">{turn.text}</p>
                  {turn.metadata?.transcriptSource && (
                    <p className="turn-meta">
                      Source: {formatTranscriptionSource(turn.metadata.transcriptSource)}
                    </p>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function StatCard({ label, value }) {
  return (
    <article className="stat-card">
      <p>{label}</p>
      <strong>{value}</strong>
    </article>
  )
}

function SupportRow({ label, value }) {
  return (
    <div className="support-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function WaveBars() {
  return (
    <div className="wave-bars" aria-hidden="true">
      {Array.from({ length: 5 }, (_, index) => (
        <span key={index} className="wave-bar" style={{ animationDelay: `${index * 90}ms` }} />
      ))}
    </div>
  )
}

export default App
