@echo off
setlocal
set "AUDIOCPP_ROOT=C:\Utilities\audio-v0.9.3-bin-windows-x64-cuda13.3"
set "AUDIOCPP_CLI=%AUDIOCPP_ROOT%\audiocpp_cli.exe"
set "BREEZE_MODEL=%AUDIOCPP_ROOT%\breeze-tts-2-q8_0.gguf"
if not defined BREEZE_TTS_TASK set "BREEZE_TTS_TASK=clon"
set "PATH=%AUDIOCPP_ROOT%;%PATH%"
if defined CUDA_PATH if exist "%CUDA_PATH%\bin\x64" set "PATH=%CUDA_PATH%\bin\x64;%PATH%"
if defined CUDA_PATH if exist "%CUDA_PATH%\bin" set "PATH=%CUDA_PATH%\bin;%PATH%"
if exist "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.4\bin\x64" set "PATH=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.4\bin\x64;%PATH%"
if exist "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.4\bin" set "PATH=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.4\bin;%PATH%"
if not exist "%AUDIOCPP_CLI%" (
  echo Breeze TTS CLI not found: "%AUDIOCPP_CLI%" 1>&2
  exit /b 2
)
if not exist "%BREEZE_MODEL%" (
  echo Breeze TTS model not found: "%BREEZE_MODEL%" 1>&2
  exit /b 2
)
"%AUDIOCPP_CLI%" --task "%BREEZE_TTS_TASK%" --family breeze_tts --model "%BREEZE_MODEL%" --backend cuda --mode offline --device 0 --threads 8 %*
exit /b %ERRORLEVEL%
