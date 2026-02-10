import { spawn } from 'child_process';

const MEDIA_MIMETYPES = ['audio/', 'video/'];
const MEDIA_EXTENSIONS = ['m4a', 'mp3', 'mp4', 'ogg', 'webm', 'wav', 'aac', 'flac', 'mov', 'avi'];

export function findMediaFile(files) {
  if (!files || !files.length) return null;
  return files.find(f => {
    const mimeMatch = MEDIA_MIMETYPES.some(t => f.mimetype?.startsWith(t));
    const extMatch = MEDIA_EXTENSIONS.includes(f.filetype?.toLowerCase());
    return mimeMatch || extMatch;
  }) || null;
}

// ── OpenAI Transcribe ────────────────────────────────────────────

async function transcribeOpenAI(fileUrl, botToken) {
  // 1. Slack에서 파일 다운로드
  const res = await fetch(fileUrl, {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  if (!res.ok) throw new Error(`Slack file download failed: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();

  // 2. 파일 확장자 추출 (URL에서)
  const ext = fileUrl.match(/\.(\w+)(?:\?|$)/)?.[1] || 'mp3';

  // 3. OpenAI Transcription API 호출
  const formData = new FormData();
  formData.append('file', new Blob([arrayBuffer]), `audio.${ext}`);
  formData.append('model', 'gpt-4o-mini-transcribe');
  formData.append('language', 'ko');
  formData.append('response_format', 'text');

  const apiRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: formData,
  });

  if (!apiRes.ok) {
    const err = await apiRes.text();
    throw new Error(`OpenAI API error ${apiRes.status}: ${err}`);
  }

  const text = (await apiRes.text()).trim();
  if (!text) throw new Error('OpenAI: 빈 응답');
  return text;
}

// ── Google STT (기존 방식, fallback) ─────────────────────────────

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const proc = spawn(cmd, args);
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `${cmd} exit: ${code}`)));
    proc.on('error', reject);
  });
}

async function transcribeGoogle(fileUrl, botToken) {
  const inputPath = '/tmp/stt-input-audio';
  const wavPath = '/tmp/stt-audio.wav';

  // 1. Slack에서 파일 다운로드
  await run('curl', ['-sL', '-H', `Authorization: Bearer ${botToken}`, fileUrl, '-o', inputPath]);

  // 2. WAV 변환 (16kHz mono)
  await run('ffmpeg', ['-i', inputPath, '-ar', '16000', '-ac', '1', wavPath, '-y']);

  // 3. venv 준비
  const venvSetup = `
if [ ! -f /tmp/stt-env/bin/python3 ]; then
  python3 -m venv /tmp/stt-env
  /tmp/stt-env/bin/pip install -q SpeechRecognition
fi`;
  await new Promise((resolve, reject) => {
    const proc = spawn('sh', ['-c', venvSetup]);
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`venv setup failed`)));
    proc.on('error', reject);
  });

  // 4. STT 수행
  return new Promise((resolve, reject) => {
    const script = `/tmp/stt-env/bin/python3 -c "
import speech_recognition as sr
r = sr.Recognizer()
with sr.AudioFile('${wavPath}') as source:
    audio = r.record(source)
try:
    text = r.recognize_google(audio, language='ko-KR')
    print(text)
except sr.UnknownValueError:
    print('ERROR: 음성을 인식할 수 없습니다')
except sr.RequestError as e:
    print(f'ERROR: Google API 요청 실패 - {e}')
"`;
    let output = '';
    let stderr = '';
    const proc = spawn('sh', ['-c', script]);
    proc.stdout.on('data', d => output += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      const text = output.trim();
      if (code === 0 && text && !text.startsWith('ERROR:')) {
        resolve(text);
      } else {
        reject(new Error(text || stderr.trim() || `STT exit: ${code}`));
      }
    });
    proc.on('error', reject);
  });
}

// ── 통합 transcribe: OpenAI 우선, Google fallback ────────────────

export async function transcribe(fileUrl, botToken) {
  if (process.env.OPENAI_API_KEY) {
    try {
      const text = await transcribeOpenAI(fileUrl, botToken);
      console.log(`[STT] Engine: OpenAI`);
      return { text, engine: 'OpenAI' };
    } catch (err) {
      console.warn(`[STT] OpenAI 실패, Google fallback: ${err.message}`);
    }
  }
  const text = await transcribeGoogle(fileUrl, botToken);
  console.log(`[STT] Engine: Google`);
  return { text, engine: 'Google' };
}
