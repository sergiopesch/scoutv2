export interface OperatorParticipant {
  id: string;
  name: string;
  role?: "operator" | "client" | "unknown";
  isBot?: boolean;
  platformIdentity?: string;
}

export interface OperatorIdentityParticipant extends OperatorParticipant {
  selected: boolean;
  roleLabel: "Operator" | "Client" | "Not assigned";
  buttonText: string;
  disabled: boolean;
}

export function humanParticipants(
  participants?: OperatorParticipant[]
): OperatorParticipant[];

export function operatorIdentityView(
  participants?: OperatorParticipant[],
  operatorParticipantId?: string,
  submittingParticipantId?: string
): OperatorIdentityParticipant[];

export function selectOperator(
  sessionId: string,
  participantId: string,
  fetchImpl?: typeof fetch
): Promise<unknown>;
