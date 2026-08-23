#!/bin/zsh
set -u

umask 077
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

VBOXMANAGE="/usr/local/bin/VBoxManage"
VM_NAME="Home Assistant"
LOG_PATH="/Users/lukesmacminim41/Library/Logs/MacMiniAI/after-login-recovery.log"
/bin/mkdir -p "${LOG_PATH:h}"

if [[ -f "$LOG_PATH" ]] && (( $(/usr/bin/stat -f %z "$LOG_PATH") > 1048576 )); then
  /bin/mv -f "$LOG_PATH" "$LOG_PATH.1"
fi

{
  print -- "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ) checking Home Assistant VM"
  VM_STATE="$($VBOXMANAGE showvminfo "$VM_NAME" --machinereadable 2>/dev/null | /usr/bin/awk -F= '/^VMState=/{gsub(/\"/,"",$2); print $2}')"
  if [[ "$VM_STATE" == "running" ]]; then
    print -- "Home Assistant VM already running"
    exit 0
  fi
  if "$VBOXMANAGE" startvm "$VM_NAME" --type headless; then
    print -- "Home Assistant VM start requested from state: ${VM_STATE:-unknown}"
    exit 0
  fi
  print -- "Home Assistant VM failed to start from state: ${VM_STATE:-unknown}"
  exit 1
} >> "$LOG_PATH" 2>&1
