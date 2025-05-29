document.addEventListener("DOMContentLoaded", () => {
  const recordButton = document.getElementById("recordButton");
  const statusMessage = document.getElementById("statusMessage");
  const aiResponseDisplay = document.getElementById("aiResponseDisplay");
  const aiPinyin = document.getElementById("aiPinyin");
  const aiHanzi = document.getElementById("aiHanzi");
  const aiEnglish = document.getElementById("aiEnglish");
  const aiAudioPlayer = document.getElementById("aiAudioPlayer");

  // Elements for user's transcribed input
  const userTranscriptDisplay = document.getElementById("userTranscriptDisplay");
  const userPinyin = document.getElementById("userPinyin");
  const userHanzi = document.getElementById("userHanzi");
  const userEnglish = document.getElementById("userEnglish");

  let mediaRecorder;
  let audioChunks = [];
  let isRecording = false;

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);

      mediaRecorder.ondataavailable = (event) => {
        audioChunks.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunks, { type: "audio/webm" }); // or 'audio/wav' or 'audio/m4a' depending on browser/encoder
        audioChunks = [];
        await sendAudioToServer(audioBlob);
        stream.getTracks().forEach((track) => track.stop()); // Release microphone
      };

      mediaRecorder.start();
      isRecording = true;
      recordButton.textContent = "🛑 Stop Recording";
      recordButton.classList.add("recording");
      statusMessage.textContent = "Recording... Speak now.";
      aiResponseDisplay.style.display = "none"; // Hide previous AI response
      userTranscriptDisplay.style.display = "none"; // Hide previous user transcript
    } catch (err) {
      console.error("Error accessing microphone:", err);
      statusMessage.textContent =
        "Error: Could not access microphone. Please grant permission.";
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
      isRecording = false;
      recordButton.textContent = "🎤 Start Recording";
      recordButton.classList.remove("recording");
      statusMessage.textContent = "Processing audio...";
    }
  }

  recordButton.addEventListener("click", () => {
    if (!isRecording) {
      startRecording();
    } else {
      stopRecording();
    }
  });

  async function sendAudioToServer(audioBlob) {
    const formData = new FormData();
    // It's important that the filename has an extension whisper recognizes, like .wav, .mp3, .webm, .m4a
    formData.append("audio_file", audioBlob, "user_audio.webm");

    statusMessage.textContent = "Transcribing and getting AI response...";

    try {
      const response = await fetch("/interact", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response
          .json()
          .catch(() => ({ detail: "Unknown server error" }));
        throw new Error(
          `Server error: ${response.status} - ${errorData.detail}`
        );
      }

      const data = await response.json();

      // Display user's transcribed input
      if (data.user_input) {
        userHanzi.textContent = data.user_input.hanzi || "...";
        userPinyin.textContent = data.user_input.pinyin || "...";
        userEnglish.textContent = data.user_input.english || "...";
        userTranscriptDisplay.style.display = "block";
      } else {
        userTranscriptDisplay.style.display = "none";
      }

      // Display AI's response
      if (data.ai_response) {
        aiHanzi.textContent = data.ai_response.hanzi || "...";
        aiPinyin.textContent = data.ai_response.pinyin || "...";
        aiEnglish.textContent = data.ai_response.english || "...";
        aiResponseDisplay.style.display = "block";
      } else {
        aiResponseDisplay.style.display = "none";
      }


      if (data.audio_url) {
        aiAudioPlayer.src = data.audio_url + `?t=${new Date().getTime()}`; // Cache buster
        aiAudioPlayer
          .play()
          .catch((e) => console.error("Error playing audio:", e));
        statusMessage.textContent = "AI responded. Playing audio...";
        aiAudioPlayer.onended = () => {
          statusMessage.textContent = "Ready. Click record to speak again.";
        };
      } else {
        statusMessage.textContent =
          "AI responded (no audio). Ready for next input.";
      }
    } catch (error) {
      console.error("Error sending audio or processing response:", error);
      statusMessage.textContent = `Error: ${error.message}. Please try again.`;
      aiResponseDisplay.style.display = "none";
      userTranscriptDisplay.style.display = "none";
    }
  }
});
