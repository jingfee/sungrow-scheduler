export interface Message {
  operation: Operation;
  power?: number;
  targetSoc?: number;
  rank?: number;
}

export enum Operation {
  StartCharge,
  StopCharge,
  StartDischarge,
  StopDischarge,
  SetDischargeAfterSolar,
}
