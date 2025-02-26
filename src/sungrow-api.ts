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

export async function setStartBatteryCharge(power: number, targetSoc: number) {
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
        set_value: targetSoc * 1000,
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
    await fetch(url, options);
  } catch (error: any) {
    console.error(error.message);
  }
}

export async function setStopBatteryCharge() {
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
    await fetch(url, options);
  } catch (error: any) {
    console.error(error.message);
  }
}

export async function setStartBatteryDischarge(
  startHour: number,
  endHour: number,
  isWeekend: boolean
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
      .toISO()} Set start battery discharge`,
    expire_second: 1800,
    param_list: [
      {
        param_code: isWeekend ? 10057 : 10048, //discharging start time 1: hour
        set_value: startHour,
      },
      {
        param_code: isWeekend ? 10059 : 10050, //weekday discharging end time 1: hour
        set_value: endHour,
      },
    ],
  });
  const options = { ...baseOptions, body };

  try {
    await fetch(url, options);
  } catch (error: any) {
    console.error(error.message);
  }
}

export async function setStopBatteryDischarge() {
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
      .toISO()} Set stop battery discharge`,
    expire_second: 1800,
    param_list: [
      {
        param_code: 10048, //weekday discharging start time 1: hour
        set_value: 24,
      },
      {
        param_code: 10050, //weekday discharging end time 1: hour
        set_value: 24,
      },
      {
        param_code: 10057, //weekend discharging start time 1: hour
        set_value: 24,
      },
      {
        param_code: 10059, //weekend discharging end time 1: hour
        set_value: 24,
      },
    ],
  });
  const options = { ...baseOptions, body };

  try {
    await fetch(url, options);
  } catch (error: any) {
    console.error(error.message);
  }
}
