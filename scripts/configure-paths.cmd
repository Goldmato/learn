@echo off
setlocal
set "PYTHON=%PI_PYTHON%"
if not defined PYTHON set "PYTHON=python"
"%PYTHON%" "%~dp0configure_paths.py" %*
