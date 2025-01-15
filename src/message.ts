export interface Message {
  operation: Operation;
  chargeHours?: number;
  targetSoc?: number;
}

export enum Operation {
  StartCharge,
  StopCharge,
}
