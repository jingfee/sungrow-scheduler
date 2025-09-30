import { InvocationContext } from '@azure/functions';
import { DateTime } from 'luxon';

const baseUrl = 'https://gateway.isolarcloud.eu/openapi';
let token;
const baseOptions = {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json;charset=UTF-8',
    sys_code: '901',
    'x-access-key': process.env['AppSecret'],
  },
};
const baseBody = {
  appkey: process.env['AppKey'],
  lang: '_en_US',
};

async function login() {
  const url = `${baseUrl}/login`;
  const body = JSON.stringify({
    ...baseBody,
    user_password: process.env['AccountPassword'],
    user_account: process.env['AccountEmail'],
  });
  const options = { ...baseOptions, body };

  try {
    const response = await fetch(url, options);
    if (!response.ok) {
      return;
    }
    const responseJson = await response.json();
    token = responseJson?.result_data?.token;
  } catch (error: any) {
    console.error(error.message);
  }
}

export async function getBatterySoc() {
  if (!token) {
    await login();
  }

  const url = `${baseUrl}/getDeviceRealTimeData`;
  const body = JSON.stringify({
    ...baseBody,
    token,
    device_type: 14,
    point_id_list: ['13141'],
    ps_key_list: [process.env['DeviceKeyId']],
  });
  const options = { ...baseOptions, body };

  try {
    const response = await fetch(url, options);
    if (!response.ok) {
      return;
    }
    const responseJson = await response.json();
    const soc =
      responseJson?.result_data?.device_point_list[0].device_point.p13141;
    return parseFloat(soc);
  } catch (error: any) {
    console.error(error.message);
  }
}

export async function getDailyLoad() {
  if (!token) {
    await login();
  }

  const url = `${baseUrl}/getDeviceRealTimeData`;
  const body = JSON.stringify({
    ...baseBody,
    token,
    device_type: 14,
    point_id_list: ['13199'],
    ps_key_list: [process.env['DeviceKeyId']],
  });
  const options = { ...baseOptions, body };

  try {
    const response = await fetch(url, options);
    if (!response.ok) {
      return;
    }
    const responseJson = await response.json();
    const dailyLoad =
      responseJson?.result_data?.device_point_list[0].device_point.p13199;
    return parseInt(dailyLoad);
  } catch (error: any) {
    console.error(error.message);
  }
}

export async function setStartBatteryCharge(
  power: number,
  targetSoc: number,
  context: InvocationContext
) {
  if (!token) {
    await login();
  }

  const url = `${baseUrl}/paramSetting`;
  const body = JSON.stringify({
    ...baseBody,
    token,
    set_type: 0,
    uuid: process.env['DeviceUuid'],
    task_name: `${DateTime.now()
      .setZone('Europe/Stockholm')
      .toISO()} Set start battery charge`,
    expire_second: 1800,
    param_list: [
      {
        param_code: 10001, //soc upper limit
        set_value: Math.max(targetSoc, 50) * 1000,
      },
      {
        param_code: 10003, //energy management mode
        set_value: 2, //compulsory mode
      },
      {
        param_code: 10004, //charging/discharing command
        set_value: 170, //charging
      },
      {
        param_code: 10005, //charging/discharing power
        set_value: power,
      },
    ],
  });
  const options = { ...baseOptions, body };

  try {
    const response = await fetch(url, options);
    context.log(await response.json());
  } catch (error: any) {
    console.error(error.message);
  }
}

export async function setStopBatteryCharge(context: InvocationContext) {
  if (!token) {
    await login();
  }

  const url = `${baseUrl}/paramSetting`;
  const body = JSON.stringify({
    ...baseBody,
    token,
    set_type: 0,
    uuid: process.env['DeviceUuid'],
    task_name: `${DateTime.now()
      .setZone('Europe/Stockholm')
      .toISO()} Set stop battery charge`,
    expire_second: 1800,
    param_list: [
      {
        param_code: 10001, //soc upper limit
        set_value: 1000,
      },
      {
        param_code: 10003, //energy management mode
        set_value: 0, //self-consumption
      },
      {
        param_code: 10004, //charging/discharging command
        set_value: 204, //stopped
      },
      {
        param_code: 10005, //charging/discharging power
        set_value: 0,
      },
    ],
  });
  const options = { ...baseOptions, body };

  try {
    const response = await fetch(url, options);
    context.log(await response.json());
  } catch (error: any) {
    console.error(error.message);
  }
}

export async function setStartBatteryDischarge(
  startHour: number,
  startMinute: number,
  endHour: number,
  endMinute: number,
  context: InvocationContext
) {
  const taskName = `${DateTime.now()
    .setZone('Europe/Stockholm')
    .toISO()} Set start battery discharge`;
  await setBatteryDischargeEndTime(
    endHour,
    endMinute,
    `${taskName} end`,
    context
  );
  await setBatteryDischargeStartTime(
    startHour,
    startMinute,
    `${taskName} start`,
    context
  );
}

export async function setStopBatteryDischarge(context: InvocationContext) {
  const taskName = `${DateTime.now()
    .setZone('Europe/Stockholm')
    .toISO()} Set stop battery discharge`;
  await setBatteryDischargeStartTime(0, 0, `${taskName} start`, context);
  await setBatteryDischargeEndTime(0, 0, `${taskName} end`, context);
}

async function setBatteryDischargeStartTime(
  hour: number,
  minute: number,
  taskName: string,
  context: InvocationContext
) {
  if (!token) {
    await login();
  }

  const now = DateTime.now().setZone('Europe/Stockholm');
  const isWeekend = now.weekday === 6 || now.weekday === 7;

  const url = `${baseUrl}/paramSetting`;
  const body = JSON.stringify({
    ...baseBody,
    token,
    set_type: 0,
    uuid: process.env['DeviceUuid'],
    task_name: taskName,
    expire_second: 1800,
    param_list: [
      {
        param_code: isWeekend ? 10057 : 10048, //discharging start time 1: hour
        set_value: hour,
      },
      {
        param_code: isWeekend ? 10058 : 10049, //discharging start time 1: minute
        set_value: minute,
      },
    ],
  });
  const options = { ...baseOptions, body };

  try {
    const response = await fetch(url, options);
    context.log(await response.json());
  } catch (error: any) {
    console.error(error.message);
  }
}

async function setBatteryDischargeEndTime(
  hour: number,
  minute: number,
  taskName: string,
  context: InvocationContext
) {
  if (!token) {
    await login();
  }

  const now = DateTime.now().setZone('Europe/Stockholm');
  const isWeekend = now.weekday === 6 || now.weekday === 7;

  const url = `${baseUrl}/paramSetting`;
  const body = JSON.stringify({
    ...baseBody,
    token,
    set_type: 0,
    uuid: process.env['DeviceUuid'],
    task_name: taskName,
    expire_second: 1800,
    param_list: [
      {
        param_code: isWeekend ? 10059 : 10050, //weekday discharging end time 1: hour
        set_value: hour,
      },
      {
        param_code: isWeekend ? 10060 : 10051, //discharging start time 1: minute
        set_value: minute,
      },
    ],
  });
  const options = { ...baseOptions, body };

  try {
    const response = await fetch(url, options);
    context.log(await response.json());
  } catch (error: any) {
    console.error(error.message);
  }
}
