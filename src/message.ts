export interface Message {
  operation: Operation;
  power?: number;
  targetSoc?: number;
}

export enum Operation {
  StartCharge,
  StopCharge,
  StartDischarge,
  StopDischarge,
}
