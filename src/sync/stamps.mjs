function normalizeCounter(value) {
  const counter = Number(value);
  return Number.isFinite(counter) && counter >= 0 ? Math.floor(counter) : 0;
}

function normalizeDeviceId(value) {
  return typeof value === "string" ? value : "";
}

export function compareStamps(left, right) {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;

  const counterDifference = normalizeCounter(left.counter) - normalizeCounter(right.counter);
  if (counterDifference !== 0) return counterDifference;

  const leftDeviceId = normalizeDeviceId(left.deviceId);
  const rightDeviceId = normalizeDeviceId(right.deviceId);
  if (leftDeviceId === rightDeviceId) return 0;
  return leftDeviceId < rightDeviceId ? -1 : 1;
}

export function nextStamp(counter, deviceId) {
  return {
    counter: normalizeCounter(counter) + 1,
    deviceId: normalizeDeviceId(deviceId),
  };
}

export function cloneStamp(stamp) {
  if (!stamp) return null;
  return {
    counter: normalizeCounter(stamp.counter),
    deviceId: normalizeDeviceId(stamp.deviceId),
  };
}

