/**
 * Voice is browser-native: Web Speech API for both directions (DESIGN §28/§29).
 * No audio ever leaves the machine and there is no extra service to run.
 */

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult:
    | ((event: { resultIndex: number; results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

type RecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isSpeechInputSupported(): boolean {
  return recognitionCtor() !== null;
}

export interface DictationHandlers {
  onTranscript(text: string, isFinal: boolean): void;
  onError(message: string): void;
  onEnd(): void;
}

/**
 * Streaming dictation. The transcript lands in the composer so the user can see
 * what was recognized before it is sent.
 */
export class Dictation {
  private recognition: SpeechRecognitionLike | null = null;
  private finalText = "";

  start(handlers: DictationHandlers): boolean {
    const Ctor = recognitionCtor();
    if (!Ctor) {
      handlers.onError("This browser does not support speech recognition.");
      return false;
    }

    const recognition = new Ctor();
    recognition.lang = navigator.language || "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;
    this.finalText = "";

    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]!;
        const text = result[0].transcript;
        if (result.isFinal) this.finalText += text;
        else interim += text;
      }
      handlers.onTranscript(`${this.finalText}${interim}`.trim(), interim === "");
    };

    recognition.onerror = (event) => {
      if (event.error !== "aborted") handlers.onError(`Speech recognition error: ${event.error}`);
    };

    recognition.onend = () => {
      this.recognition = null;
      handlers.onEnd();
    };

    this.recognition = recognition;
    recognition.start();
    return true;
  }

  stop(): void {
    this.recognition?.stop();
  }

  get active(): boolean {
    return this.recognition !== null;
  }
}

/** Agent voice output. Speaking again interrupts whatever is playing (barge-in). */
export function speak(text: string): void {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.05;
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}
