param(
	[Parameter(ValueFromRemainingArguments = $true)]
	[string[]]$Arguments
)

$ErrorActionPreference = "Stop"
$configPath = Join-Path (Split-Path -Parent $PSScriptRoot) "local-paths.json"
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
	throw "Breeze path settings are missing. Run /configure-paths in Pi."
}

$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if ($config.version -ne 1 -or -not $config.audioCppRoot) {
	throw "Set the audio.cpp install folder with /configure-paths in Pi."
}

$configRoot = Split-Path -Parent $configPath
$audioCppRoot = [System.IO.Path]::GetFullPath([string]$config.audioCppRoot, $configRoot)
$cli = Join-Path $audioCppRoot "audiocpp_cli.exe"
$model = Join-Path $audioCppRoot "breeze-tts-2-q8_0.gguf"
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
	throw "Breeze TTS CLI not found: $cli"
}
if (-not (Test-Path -LiteralPath $model -PathType Leaf)) {
	throw "Breeze TTS model not found: $model"
}

$env:BREEZE_TTS_TASK = if ($env:BREEZE_TTS_TASK) { $env:BREEZE_TTS_TASK } else { "clon" }
$pathEntries = @($audioCppRoot)
if ($config.cudaRootDirectory) {
	$cudaRootDirectory = [System.IO.Path]::GetFullPath([string]$config.cudaRootDirectory, $configRoot)
	foreach ($cudaDirectory in @((Join-Path $cudaRootDirectory "bin\x64"), (Join-Path $cudaRootDirectory "bin"))) {
		if (Test-Path -LiteralPath $cudaDirectory -PathType Container) {
			$pathEntries += $cudaDirectory
		}
	}
} elseif ($env:CUDA_PATH) {
	foreach ($cudaDirectory in @((Join-Path $env:CUDA_PATH "bin\x64"), (Join-Path $env:CUDA_PATH "bin"))) {
		if (Test-Path -LiteralPath $cudaDirectory -PathType Container) {
			$pathEntries += $cudaDirectory
		}
	}
}
$env:PATH = ($pathEntries + $env:PATH) -join [System.IO.Path]::PathSeparator

& $cli --task $env:BREEZE_TTS_TASK --family breeze_tts --model $model --backend cuda --mode offline --device 0 --threads 8 @Arguments
exit $LASTEXITCODE
