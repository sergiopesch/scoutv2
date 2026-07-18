import { sessionApiPath } from "./session-id.js";

export function humanParticipants(participants = []) {
  const byIdentity = new Map();
  for (const participant of participants) {
    if (participant?.isBot === true) continue;
    const key = participant.platformIdentity
      ? `platform:${participant.platformIdentity}`
      : `participant:${participant.id}`;
    byIdentity.set(key, participant);
  }
  return [...byIdentity.values()];
}

export function operatorIdentityView(
  participants = [],
  operatorParticipantId,
  submittingParticipantId
) {
  const humans = humanParticipants(participants);
  return humans.map((participant) => {
    const selected = participant.id === operatorParticipantId;
    return {
      ...participant,
      selected,
      roleLabel: selected
        ? "Operator"
        : operatorParticipantId
          ? "Client"
          : "Not assigned",
      buttonText:
        submittingParticipantId === participant.id
          ? "Selecting…"
          : selected
            ? "Selected"
            : operatorParticipantId
              ? "Make operator"
              : "This is me",
      disabled: selected || Boolean(submittingParticipantId)
    };
  });
}

export async function selectOperator(
  sessionId,
  participantId,
  fetchImpl = globalThis.fetch
) {
  const response = await fetchImpl(`${sessionApiPath(sessionId)}/operator`, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ participantId })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      result.error || `Operator selection failed (${response.status}).`
    );
  }
  return result;
}
