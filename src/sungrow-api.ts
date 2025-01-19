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
    return soc;
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
    task_name: 'test',
    expire_second: 1800,
    param_list: [
      {
        param_code: 10001,
        set_value: targetSoc * 10,
      },
      {
        param_code: 10003,
        set_value: 2,
      },
      {
        param_code: 10004,
        set_value: 170,
      },
      {
        param_code: 10005,
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
    task_name: 'test',
    expire_second: 1800,
    param_list: [
      {
        param_code: 10003,
        set_value: 0,
      },
      {
        param_code: 10004,
        set_value: 204,
      },
      {
        param_code: 10005,
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

export async function setStartBatteryDischarge() {
  if (!token) {
    await login();
  }

  const url = `${baseUrl}/paramSetting`;
  const body = JSON.stringify({
    ...baseBody,
    token,
    set_type: 0,
    uuid: process.env['DeviceUuid'],
    task_name: 'test',
    expire_second: 1800,
    param_list: [
      {
        param_code: 10003,
        set_value: 2,
      },
      {
        param_code: 10004,
        set_value: 187,
      },
      {
        param_code: 10005,
        set_value: 6000,
      },
      {
        param_code: 10012,
        set_value: 170,
      },
      {
        param_code: 10013,
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
    task_name: 'test',
    expire_second: 1800,
    param_list: [
      {
        param_code: 10003,
        set_value: 0,
      },
      {
        param_code: 10004,
        set_value: 204,
      },
      {
        param_code: 10005,
        set_value: 0,
      },
      {
        param_code: 10012,
        set_value: 85,
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
