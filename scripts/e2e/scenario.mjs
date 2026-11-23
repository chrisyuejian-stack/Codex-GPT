import assert from 'node:assert/strict';
import { fixture } from '../../tests/support.mjs';
import { schoolFixture } from '../../tests/fixtures-school.mjs';
import { b64, bytes, sha } from '../../src/server/core.js';

export const SCENARIO_NOW = '2026-11-12T10:30:00+08:00';
export const SCENARIO_KINDS = ['fengqin', 'auth', 'attendance'];

async function createLegacyAttendanceScenario() {
  const f = await fixture();
  try {
    const s = await schoolFixture(f, 'e2e');
    const call = async (path, method, data) => {
      const result = await s.call(path, method, data);
      assert.equal(result.status, path === 'accounts' ? 201 : 200, `${path}: unexpected HTTP ${result.status}`);
      return result.body;
    };
    const create = async (resource, data) => (await call(`data/${resource}`, 'POST', data)).id;
    const teacher = await create('teachers', { name: '测试主讲教师' });
    const room = await create('locations', { name: '验收琴房', capacity: 10 });
    const category = await create('course_categories', { name: '验收钢琴' });
    const course = await create('course_types', { name: '上线验收钢琴班课', category_id: category, format: 'group', capacity: 10 });
    const studentIds = [];
    const packageIds = [];
    for (const [i, name] of ['测试学员小枫', '测试学员小琴'].entries()) {
      studentIds.push(await create('students', { name, grade: '小学3年级' }));
      packageIds.push((await call('credits/packages', 'POST', {
        operation_id: crypto.randomUUID(), student_id: studentIds[i], course_type_id: course,
        units_total: i ? 8 : 10, unit_price: 100, purchase_date: '2026-11-01',
      })).id);
    }
    await call('finance/rates', 'POST', {
      operation_id: crypto.randomUUID(), teacher_id: teacher, course_type_id: course,
      rate_basis: 'lesson', rate: 120, effective_from: '2026-01-01', effective_to: '2026-12-31',
    });
    const lesson = await create('lessons', {
      start_at: '2026-11-12T19:00', teacher_id: teacher, course_type_id: course,
      location_id: room, duration: 45, units: 1, student_ids: studentIds,
    });
    const tokens = { supervisor: s.token };
    for (const [i, role] of ['academic', 'finance', 'teacher', 'student', 'student2'].entries()) {
      const actualRole = role === 'student2' ? 'student' : role;
      const u = await call('accounts', 'POST', {
        name: `验收-${role}`, phone: `1390000000${i + 1}`, roles: [actualRole],
        ...(role === 'teacher' ? { teacher_id: teacher } : {}),
        ...(actualRole === 'student' ? { student_id: studentIds[role === 'student2' ? 1 : 0] } : {}),
      });
      f.db.raw.prepare('UPDATE users SET must_change=0 WHERE tenant_id=? AND id=?').run(s.t.id, u.id);
      const token = b64(bytes(32));
      await s.r.createSession(await sha(token), await s.r.user(u.id), { ip: 'local', ua: 'e2e' });
      tokens[role] = token;
    }
    f.db.raw.exec('DELETE FROM security_limits');
    f.env.APP_HOST = 'localhost';
    const manifest = { kind: 'attendance', now: SCENARIO_NOW, slug: s.t.slug, studentIds, packageIds, teacher, room, courseId: course, lesson };
    return { f, tokens, manifest, state: async () => ({}), renewSessions: async () => {} };
  } catch (error) {
    f.restore();
    throw error;
  }
}

export async function createScenario(kind = 'attendance') {
  if (!SCENARIO_KINDS.includes(kind)) throw Error(`Unknown scenario: ${kind}`);
  if (kind === 'attendance') return createLegacyAttendanceScenario();
  const f = await fixture();
  try {
    const s = await schoolFixture(f, 'e2e');
    f.env.APP_HOST = 'localhost';
    const call = async (path, method, data, token = s.token) => {
      const headers = { Cookie: `__Host-fengqin_session=${token}`, Origin: 'http://localhost' };
      let body;
      if (data !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(data);
      }
      const res = await f.directRequest(`http://localhost/api/${path}`, { method, headers, body });
      const text = await res.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      assert.equal(
        res.status,
        path === 'accounts' && method === 'POST' ? 201 : 200,
        `${method} /api/${path}: unexpected HTTP ${res.status} ${String(text).slice(0, 240)}`
      );
      return parsed;
    };
    const create = async (resource, data) => (await call(`data/${resource}`, 'POST', data)).id;

    // 1. 基础资料：课程大类、细分课程、老师、教室、课酬
    const cats = {
      piano: await create('course_categories', { name: '钢琴', color: '#8B7BB5' }),
      voice: await create('course_categories', { name: '声乐', color: '#B7768C' }),
      theory: await create('course_categories', { name: '乐理', color: '#C99A54' }),
      comp: await create('course_categories', { name: '作曲与制作', color: '#5B8DB8' }),
    };
    const courses = {
      piano: await create('course_types', { name: '钢琴 1 对 1', category_id: cats.piano, format: 'individual', capacity: 1, default_minutes: 60, units_per_lesson: 1 }),
      voice: await create('course_types', { name: '声乐 1 对 1', category_id: cats.voice, format: 'individual', capacity: 1, default_minutes: 60, units_per_lesson: 1 }),
      theory: await create('course_types', { name: '乐理与视唱练耳', category_id: cats.theory, format: 'group', capacity: 8, default_minutes: 60, units_per_lesson: 1 }),
      comp: await create('course_types', { name: '音乐制作 · 作品集', category_id: cats.comp, format: 'individual', capacity: 1, default_minutes: 60, units_per_lesson: 1 }),
    };
    const teachers = {
      li: await create('teachers', { name: '李嘉文', phone: '13700000001' }),
      emily: await create('teachers', { name: 'Emily', phone: '13700000002' }),
      zhou: await create('teachers', { name: '周舟', phone: '13700000003' }),
    };
    const rooms = {
      r302: await create('locations', { name: '302 琴房', capacity: 2 }),
      r305: await create('locations', { name: '305 琴房', capacity: 2 }),
      r201: await create('locations', { name: '201 教室', capacity: 10 }),
    };
    for (const [t, c, rate] of [
      ['li', 'piano', 300],
      ['emily', 'voice', 350],
      ['zhou', 'theory', 200],
    ]) {
      await call('finance/rates', 'POST', {
        operation_id: crypto.randomUUID(),
        teacher_id: teachers[t],
        course_type_id: courses[c],
        rate_basis: 'lesson',
        rate,
        effective_from: '2026-01-01',
        effective_to: '2027-12-31',
      });
    }

    // 2. 虚构学员（王一然尾号 0008 供尾号搜索验收）
    const studentSpecs = [
      { key: 'wang', name: '王一然', grade: '高二', direction: '古典钢琴', parent_name: '王妈妈', parent_phone: '13800000008' },
      { key: 'chen', name: '陈思语', grade: '高三', direction: '声乐', parent_name: '陈爸爸', parent_phone: '13900000002' },
      { key: 'zhao', name: '赵子航', grade: '大三', direction: '音乐制作', parent_name: '赵先生', parent_phone: '13900000003' },
      { key: 'lin', name: '林可欣', grade: '高一', direction: '作曲', parent_name: '林女士', parent_phone: '13900000004' },
      { key: 'xu', name: '许嘉宁', grade: '高三', direction: '古典钢琴', parent_name: '许妈妈', parent_phone: '13900000005' },
    ];
    const students = {};
    for (const spec of studentSpecs) {
      students[spec.key] = await create('students', {
        name: spec.name,
        grade: spec.grade,
        direction: spec.direction,
        parent_name: spec.parent_name,
        parent_phone: spec.parent_phone,
      });
    }

    // 3. 课时包（含 1 个未定价包供财务补价格，1 个低余额包供续费提醒）
    const packages = {};
    packages.wangPiano = (await call('credits/packages', 'POST', {
      operation_id: crypto.randomUUID(),
      student_id: students.wang,
      course_type_id: courses.piano,
      units_total: 10,
      unit_price: 160,
      purchase_date: '2026-11-01',
    })).id;
    packages.wangTheory = (await call('credits/packages', 'POST', {
      operation_id: crypto.randomUUID(),
      student_id: students.wang,
      course_type_id: courses.theory,
      units_total: 20,
      unit_price: 80,
      purchase_date: '2026-11-01',
    })).id;
    packages.chenVoice = (await call('credits/packages', 'POST', {
      operation_id: crypto.randomUUID(),
      student_id: students.chen,
      course_type_id: courses.voice,
      units_total: 20,
      unit_price: 320,
      purchase_date: '2026-11-01',
    })).id;
    // 未定价课时包（不传 unit_price）
    packages.chenUnpriced = (await call('credits/packages', 'POST', {
      operation_id: crypto.randomUUID(),
      student_id: students.chen,
      course_type_id: courses.piano,
      units_total: 10,
      purchase_date: '2026-11-02',
    })).id;
    // 低余额课时包（2 课时，触发续费提醒）
    packages.zhaoLow = (await call('credits/packages', 'POST', {
      operation_id: crypto.randomUUID(),
      student_id: students.zhao,
      course_type_id: courses.comp,
      units_total: 2,
      unit_price: 400,
      purchase_date: '2026-11-01',
    })).id;
    packages.linPiano = (await call('credits/packages', 'POST', {
      operation_id: crypto.randomUUID(),
      student_id: students.lin,
      course_type_id: courses.piano,
      units_total: 15,
      unit_price: 160,
      purchase_date: '2026-11-01',
    })).id;
    packages.xuPiano = (await call('credits/packages', 'POST', {
      operation_id: crypto.randomUUID(),
      student_id: students.xu,
      course_type_id: courses.piano,
      units_total: 20,
      unit_price: 160,
      purchase_date: '2026-11-01',
    })).id;

    // 4. 缴费记录：王一然 1 笔已分配缴费，林可欣 1 笔未分配（待核对）缴费
    const paymentWang = (await call('credits/payments', 'POST', {
      operation_id: crypto.randomUUID(),
      student_id: students.wang,
      amount: 1600,
      paid_at: '2026-11-05',
      method: '微信',
      note: '一期钢琴学费',
      allocations: [{ package_id: packages.wangPiano, amount: 1600 }],
    })).id;
    const paymentLinUnresolved = (await call('credits/payments', 'POST', {
      operation_id: crypto.randomUUID(),
      student_id: students.lin,
      amount: 1000,
      paid_at: '2026-11-10',
      method: '转账',
      note: '待核对转账收款',
    })).id;

    // 5. 课程安排（固定在 2026-11-09 周一 ～ 2026-11-15 周日，当前时间 2026-11-12T10:30）
    const lessons = {};
    // 5.1 周二已完成并有已发布老师点评的课（供学员端点评与首页展示）
    lessons.pastConfirmed = await create('lessons', {
      start_at: '2026-11-10T10:00',
      teacher_id: teachers.li,
      course_type_id: courses.piano,
      location_id: rooms.r302,
      duration: 60,
      units: 1,
      student_ids: [students.wang],
    });
    const pastRow = (await call(`data/lessons/${lessons.pastConfirmed}`, 'GET')).record;
    await call(`credits/lessons/${lessons.pastConfirmed}/status`, 'POST', {
      operation_id: crypto.randomUUID(),
      lesson_version: pastRow.version,
      status: 'completed',
    });
    const pastReview = await call(`lessons/${lessons.pastConfirmed}/review`, 'GET');
    await call(`lessons/${lessons.pastConfirmed}/comments`, 'PUT', {
      operation_id: crypto.randomUUID(),
      comment_fingerprint: pastReview.comment_fingerprint,
      public_text: '课堂状态很好，节奏较上周更稳定。',
      homework: '节拍器 66 速度分手练习',
      people: pastReview.participants.map(p => ({
        participant_id: p.id,
        student_id: p.student_id,
        comment: '指法清晰，注意踏板控制与乐句呼吸。',
      })),
    });

    // 5.2 今天上午 09:00-10:00 已下课待点名的课（李嘉文主讲，王一然）
    lessons.todayTodo = await create('lessons', {
      start_at: '2026-11-12T09:00',
      teacher_id: teachers.li,
      course_type_id: courses.piano,
      location_id: rooms.r302,
      duration: 60,
      units: 1,
      student_ids: [students.wang],
    });

    // 5.3 今天下午 14:00-15:00 未开始（Emily，陈思语，供排课冲突与请假补课验收）
    lessons.todayAfternoon = await create('lessons', {
      start_at: '2026-11-12T14:00',
      teacher_id: teachers.emily,
      course_type_id: courses.voice,
      location_id: rooms.r305,
      duration: 60,
      units: 1,
      student_ids: [students.chen],
    });

    // 5.4 明天下午 15:00-16:00 班课（周舟，王一然 + 陈思语）
    lessons.tomorrowGroup = await create('lessons', {
      start_at: '2026-11-13T15:00',
      teacher_id: teachers.zhou,
      course_type_id: courses.theory,
      location_id: rooms.r201,
      duration: 60,
      units: 1,
      student_ids: [students.wang, students.chen],
    });

    // 5.5 周六上午 10:00-11:00（李嘉文，许嘉宁）
    lessons.saturdayPiano = await create('lessons', {
      start_at: '2026-11-14T10:00',
      teacher_id: teachers.li,
      course_type_id: courses.piano,
      location_id: rooms.r302,
      duration: 60,
      units: 1,
      student_ids: [students.xu],
    });

    // 6. 线索与回访记录
    const leads = {};
    leads.trial = (await call('tools/leads', 'POST', {
      name: '周小乐',
      phone: '13600001001',
      source: '朋友介绍',
      direction: '古典钢琴',
      grade: '高一',
      stage: 'trial',
      next_followup: '2026-11-12',
      trial_at: '2026-11-14T10:00',
      note: '已预约本周试听',
    })).id;
    await call(`tools/leads/${leads.trial}/followups`, 'POST', {
      operation_id: crypto.randomUUID(),
      version: 1,
      channel: 'phone',
      content: '首次沟通：家长希望系统学习古典钢琴并准备考级。',
      next_followup: '2026-11-12',
    });
    leads.fresh = (await call('tools/leads', 'POST', {
      name: '吴小艺',
      phone: '13600001002',
      source: '小红书',
      direction: '声乐',
      grade: '高二',
      stage: 'new',
      next_followup: '2026-11-13',
      note: '咨询一对一声乐课',
    })).id;
    leads.contacted = (await call('tools/leads', 'POST', {
      name: '郑小琴',
      phone: '13600001003',
      source: '到店咨询',
      direction: '乐理与视唱练耳',
      grade: '初三',
      stage: 'contacted',
      next_followup: '2026-11-12',
      note: '关注周末班课时间',
    })).id;

    // 7. 系统开关
    for (const key of ['teacher_self_checkin', 'student_view_balance', 'student_view_payments']) {
      await call('settings', 'PUT', { key, value: true });
    }

    // 8. 五类角色账号（支持 session 注入 + 真实账密登录）
    const tokens = { supervisor: s.token };
    const users = { supervisor: s.user.id };
    const loginAccounts = {
      supervisor: { phone: '13911112222', password: 'PhaseTwoSecure9' },
    };
    const roleSpecs = [
      { key: 'academic', name: '验收教务', phone: '13700000002', roles: ['academic'], password: 'AcademicTest9Z' },
      { key: 'finance', name: '验收财务', phone: '13700000003', roles: ['finance'], password: 'FinanceTest9Z' },
      { key: 'teacher', name: '李嘉文', phone: '13700000001', roles: ['teacher'], password: 'TeacherTest9Z', teacher_id: teachers.li },
      { key: 'student', name: '王一然', phone: '13800000008', roles: ['student'], password: 'StudentTest9Z', student_id: students.wang },
      { key: 'student2', name: '陈思语', phone: '13800000009', roles: ['student'], password: 'StudentTwo9Z', student_id: students.chen },
    ];
    for (const spec of roleSpecs) {
      const created = await call('accounts', 'POST', {
        name: spec.name,
        phone: spec.phone,
        roles: spec.roles,
        ...(spec.teacher_id ? { teacher_id: spec.teacher_id } : {}),
        ...(spec.student_id ? { student_id: spec.student_id } : {}),
      });
      // 用临时密码登录并修改为固定密码，确保真实登录可用且非 must_change 状态
      const tmpRes = await f.directRequest('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: spec.phone, password: created.temporary_password }),
      });
      assert.equal(tmpRes.status, 200, `temp login failed for ${spec.key}`);
      const setCookie = tmpRes.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
      const pwRes = await f.directRequest('http://localhost/api/password', {
        method: 'POST',
        headers: { Origin: 'http://localhost', Cookie: setCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ old_password: created.temporary_password, password: spec.password }),
      });
      assert.equal(pwRes.status, 200, `password change failed for ${spec.key}`);
      if (kind === 'auth') {
        f.db.raw.prepare('UPDATE users SET must_change=1 WHERE tenant_id=? AND id=?').run(s.t.id, created.id);
      }
      const token = b64(bytes(32));
      await s.r.createSession(await sha(token), await s.r.user(created.id), { ip: 'local', ua: 'e2e' });
      tokens[spec.key] = token;
      users[spec.key] = created.id;
      loginAccounts[spec.key] = { phone: spec.phone, password: spec.password };
    }

    // 固定学员、老师、线索的 created_at 顺序，确保视觉回归列表顺序 100% 确定
    const baseTs = Date.parse(SCENARIO_NOW) - 60_000;
    Object.values(students).forEach((id, idx) => {
      f.db.raw.prepare('UPDATE students SET created_at=?, updated_at=? WHERE tenant_id=? AND id=?').run(baseTs + idx * 1000, baseTs + idx * 1000, s.t.id, id);
    });
    Object.values(teachers).forEach((id, idx) => {
      f.db.raw.prepare('UPDATE teachers SET created_at=?, updated_at=? WHERE tenant_id=? AND id=?').run(baseTs + idx * 1000, baseTs + idx * 1000, s.t.id, id);
    });
    Object.values(leads).forEach((id, idx) => {
      f.db.raw.prepare('UPDATE leads SET created_at=?, updated_at=? WHERE tenant_id=? AND id=?').run(baseTs + idx * 1000, baseTs + idx * 1000, s.t.id, id);
    });

    // 清空限流计数，确保测试可稳定执行登录
    f.db.raw.exec('DELETE FROM security_limits');
    f.env.APP_HOST = 'localhost';

    const manifest = {
      kind,
      now: SCENARIO_NOW,
      slug: s.t.slug,
      teachers,
      rooms,
      courses,
      students,
      packages,
      lessons,
      leads,
      payments: { wang: paymentWang, linUnresolved: paymentLinUnresolved },
      loginAccounts,
    };

    async function renewSessions() {
      for (const [role, id] of Object.entries(users)) {
        const token = b64(bytes(32));
        await s.r.createSession(await sha(token), await s.r.user(id), { ip: 'local', ua: 'e2e-clock-refresh' });
        tokens[role] = token;
      }
    }

    async function state() {
      const all = (sql, ...args) => f.db.raw.prepare(sql).all(...args);
      return {
        lessons: all('SELECT id,start_at,duration,units,teacher_id,location_id,course_type_id,status FROM lessons WHERE tenant_id=? AND deleted_at IS NULL ORDER BY start_at,id', s.t.id),
        participants: all('SELECT id,lesson_id,student_id,attendance,deducted,makeup_for FROM lesson_participants WHERE tenant_id=? AND deleted_at IS NULL ORDER BY lesson_id,student_id', s.t.id),
        makeupLinks: all('SELECT original_participant_id,target_participant_id,target_lesson_id FROM makeup_links WHERE tenant_id=? AND deleted_at IS NULL', s.t.id),
        submissions: all('SELECT id,lesson_id,status,reason,public_text FROM lesson_submissions WHERE tenant_id=? ORDER BY created_at,id', s.t.id),
        comments: all('SELECT lesson_id,student_id,text,homework FROM lesson_comments WHERE tenant_id=? AND deleted_at IS NULL ORDER BY created_at,id', s.t.id),
        students: all('SELECT id,name,grade,direction,status FROM students WHERE tenant_id=? AND deleted_at IS NULL ORDER BY created_at,id', s.t.id),
        leads: all('SELECT id,name,stage,student_id,next_followup FROM leads WHERE tenant_id=? AND deleted_at IS NULL ORDER BY created_at,id', s.t.id),
        followups: all('SELECT id,lead_id,content,next_followup FROM lead_followups WHERE tenant_id=? ORDER BY created_at,id', s.t.id),
        snoozes: all('SELECT user_id,item_key,until_at FROM todo_snoozes WHERE tenant_id=? ORDER BY item_key', s.t.id),
        packages: all(`SELECT p.id,p.student_id,p.course_type_id,p.units_total,p.unit_price,p.amount,
          COALESCE((SELECT SUM(x.amount) FROM package_receipt_lines x WHERE x.tenant_id=p.tenant_id AND x.package_id=p.id),0) AS paidCents,
          COALESCE((SELECT SUM(t.delta) FROM package_transactions t WHERE t.tenant_id=p.tenant_id AND t.package_id=p.id AND t.deleted_at IS NULL),0) AS unitsBalance
          FROM packages p WHERE p.tenant_id=? AND p.deleted_at IS NULL ORDER BY p.id`, s.t.id),
        payments: all('SELECT id,student_id,amount,paid_at,method,note,deleted_at FROM student_payments WHERE tenant_id=? ORDER BY id', s.t.id),
        allocations: all('SELECT id,student_id,package_id,payment_id,amount,deleted_at FROM student_payment_allocations WHERE tenant_id=? ORDER BY id', s.t.id),
        resolutions: all('SELECT * FROM student_payment_resolutions WHERE tenant_id=? AND deleted_at IS NULL ORDER BY id', s.t.id),
        maxQueries: Math.max(0, ...f.db.queryReports.map(x => x.queries)),
      };
    }

    return { f, tokens, manifest, state, renewSessions };
  } catch (error) {
    f.restore();
    throw error;
  }
}
