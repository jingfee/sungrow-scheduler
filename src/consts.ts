export const BATTERY_UPGRADED = false;

export const SEK_THRESHOLD = 0.3;
export const MIN_SOC = 0.25;
export const BATTERY_CAPACITY = BATTERY_UPGRADED ? 25600 : 9600;
// TODO: ADAPT THIS BASED ON WEATHER/PREVIOUS LOAD
export const CHARGE_ENERGY_PER_HOUR = 3000;

export const DAY_CHARGE_CHARGE_POWER_TABLE = BATTERY_UPGRADED
  ? {
      1: {
        1: 3000,
        2: 3750,
        3: 4500,
        4: 5000,
        5: 5000,
        6: 5000,
      },
      2: {
        1: 2000,
        2: 2750,
        3: 3500,
        4: 4250,
        5: 5000,
        6: 5000,
      },
    }
  : {
      1: {
        1: 2500,
        2: 5000,
        3: 5000,
        4: 5000,
        5: 5000,
        6: 5000,
      },
      2: {
        1: 1500,
        2: 3000,
        3: 3000,
        4: 3000,
        5: 3000,
        6: 3000,
      },
    };
