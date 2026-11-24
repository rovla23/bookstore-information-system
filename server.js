'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Op, fn, col, literal, ValidationError } = require('sequelize');

const {
  sequelize,
  Author,
  Genre,
  Book,
  Customer,
  Order,
  OrderItem,
  User,
} = require('./models');

const PORT = process.env.PORT || 3000;

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Власна помилка з HTTP-статусом
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Сесії (токени зберігаються в пам'яті сервера)
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 годин
const sessions = new Map();

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { user, expires: Date.now() + SESSION_TTL_MS });
  return token;
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expires <= now) {
      sessions.delete(token);
    }
  }
}, 10 * 60 * 1000);
cleanupTimer.unref();

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+([a-f0-9]{64})$/i);
  const session = match ? sessions.get(match[1]) : null;

  if (!session || session.expires <= Date.now()) {
    if (match) {
      sessions.delete(match[1]);
    }
    return res.status(401).json({ error: 'Потрібна авторизація. Увійдіть до системи.' });
  }

  req.user = session.user;
  req.token = match[1];
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: 'Недостатньо прав для цієї дії (потрібна роль: адміністратор)' });
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Вибірки через ORM та серіалізація у формат, який очікує фронтенд
// ---------------------------------------------------------------------------

const BOOK_INCLUDE = [
  { model: Author, as: 'author', attributes: ['id', 'first_name', 'last_name', 'country', 'bio'] },
  { model: Genre, as: 'genre', attributes: ['id', 'name'] },
];

function serializeBook(book) {
  const author = book.author;
  const genre = book.genre;

  return {
    id: book.id,
    title: book.title,
    isbn: book.isbn,
    publication_year: book.publication_year,
    author_id: book.author_id,
    genre_id: book.genre_id,
    author_name: author ? `${author.first_name} ${author.last_name}` : null,
    author_country: author ? author.country : null,
    author_bio: author ? author.bio : null,
    genre_name: genre ? genre.name : null,
    price: Number(book.price),
    stock_quantity: book.stock_quantity,
  };
}

const ORDER_INCLUDE = [
  { model: Customer, as: 'customer', attributes: ['id', 'full_name'] },
  {
    model: OrderItem,
    as: 'items',
    attributes: ['id', 'book_id', 'quantity', 'price'],
    include: [{ model: Book, as: 'book', attributes: ['id', 'title'] }],
  },
];

const ITEMS_SORT = [{ model: OrderItem, as: 'items' }, 'id', 'ASC'];

function serializeOrder(order) {
  return {
    id: order.id,
    customer_id: order.customer_id,
    customer_name: order.customer ? order.customer.full_name : null,
    order_date: order.order_date,
    status: order.status,
    total_amount: Number(order.total_amount),
    items: (order.items || []).map((item) => ({
      book_id: item.book_id,
      title: item.book ? item.book.title : '',
      quantity: item.quantity,
      price: Number(item.price),
    })),
  };
}

async function getBookById(id) {
  const book = await Book.findByPk(id, { include: BOOK_INCLUDE });
  return book ? serializeBook(book) : null;
}

async function getOrderById(id) {
  const order = await Order.findByPk(id, {
    include: ORDER_INCLUDE,
    order: [ITEMS_SORT],
  });
  return order ? serializeOrder(order) : null;
}

// ---------------------------------------------------------------------------
// Допоміжні функції та валідація
// ---------------------------------------------------------------------------

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isEmpty(value) {
  return value === '' || value === null || value === undefined;
}

function validateBook(body) {
  if (!body || typeof body !== 'object') {
    return { error: 'Тіло запиту має бути JSON-об\'єктом' };
  }

  const title = str(body.title);
  if (!title) {
    return { error: 'Назва книги є обов\'язковою' };
  }
  if (title.length > 200) {
    return { error: 'Назва книги не може перевищувати 200 символів' };
  }

  const isbn = str(body.isbn).replace(/\s/g, '').toUpperCase();
  const isbnDigits = isbn.replace(/-/g, '');
  if (!/^[0-9X-]{10,17}$/.test(isbn) || !/^(\d{13}|\d{9}[\dX])$/.test(isbnDigits)) {
    return { error: 'ISBN має містити 10 або 13 символів (допускаються дефіси), наприклад 978-966-10-0001-1' };
  }

  const maxYear = new Date().getFullYear() + 1;
  const year = Number(body.publication_year);
  if (isEmpty(body.publication_year) || !Number.isInteger(year) || year < 1450 || year > maxYear) {
    return { error: `Рік видання має бути цілим числом від 1450 до ${maxYear}` };
  }

  const authorId = parseId(body.author_id);
  if (!authorId) {
    return { error: 'Потрібно вибрати автора' };
  }

  const genreId = parseId(body.genre_id);
  if (!genreId) {
    return { error: 'Потрібно вибрати жанр' };
  }

  const price = Number(body.price);
  if (isEmpty(body.price) || !Number.isFinite(price) || price < 0 || price > 99999999.99) {
    return { error: 'Ціна має бути невід\'ємним числом' };
  }

  const stock = Number(body.stock_quantity);
  if (isEmpty(body.stock_quantity) || !Number.isInteger(stock) || stock < 0 || stock > 1000000) {
    return { error: 'Кількість має бути невід\'ємним цілим числом' };
  }

  return {
    value: {
      title,
      isbn,
      publication_year: year,
      price: Math.round(price * 100) / 100,
      stock_quantity: stock,
      author_id: authorId,
      genre_id: genreId,
    },
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-z0-9_.-]{3,30}$/;

function validateRegistration(body) {
  if (!body || typeof body !== 'object') {
    return { error: 'Тіло запиту має бути JSON-об\'єктом' };
  }

  const username = str(body.username).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';

  if (!USERNAME_RE.test(username)) {
    return { error: 'Логін: 3–30 символів (латиниця, цифри, . _ -)' };
  }
  if (password.length < 6 || Buffer.byteLength(password, 'utf8') > 72) {
    return { error: 'Пароль має містити від 6 до 72 символів' };
  }

  return { value: { username, password } };
}

function validateCustomer(body) {
  if (!body || typeof body !== 'object') {
    return { error: 'Тіло запиту має бути JSON-об\'єктом' };
  }

  const fullName = str(body.full_name);
  const phone = str(body.phone).replace(/[\s\-()]/g, '');
  const email = str(body.email).toLowerCase();
  const address = str(body.address);

  if (!fullName || fullName.length > 150) {
    return { error: 'Повне ім\'я є обов\'язковим (до 150 символів)' };
  }
  if (!/^\+?[0-9]{7,15}$/.test(phone)) {
    return { error: 'Вкажіть коректний номер телефону (7–15 цифр, можна з +)' };
  }
  if (!EMAIL_RE.test(email) || email.length > 150) {
    return { error: 'Вкажіть коректний email' };
  }
  if (!address || address.length > 255) {
    return { error: 'Адреса є обов\'язковою (до 255 символів)' };
  }

  return { value: { full_name: fullName, phone, email, address } };
}

function validateAuthor(body) {
  if (!body || typeof body !== 'object') {
    return { error: 'Тіло запиту має бути JSON-об\'єктом' };
  }

  const firstName = str(body.first_name);
  const lastName = str(body.last_name);
  const country = str(body.country);
  const bio = str(body.bio);

  if (!firstName || firstName.length > 80) {
    return { error: 'Ім\'я автора є обов\'язковим (до 80 символів)' };
  }
  if (!lastName || lastName.length > 80) {
    return { error: 'Прізвище автора є обов\'язковим (до 80 символів)' };
  }
  if (!country || country.length > 100) {
    return { error: 'Країна є обов\'язковою (до 100 символів)' };
  }
  if (bio.length > 5000) {
    return { error: 'Біографія не може перевищувати 5000 символів' };
  }

  return {
    value: {
      first_name: firstName,
      last_name: lastName,
      country,
      bio: bio || null,
    },
  };
}

// ---------------------------------------------------------------------------
// Обробка помилок (власних, ORM та PostgreSQL)
// ---------------------------------------------------------------------------

function handleError(err, res) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }

  console.error('Помилка:', err.message);

  // Sequelize загортає помилку PostgreSQL у err.original / err.parent
  const db = err.original || err.parent || err;

  switch (db.code) {
    case '23503':
      if (db.constraint === 'fk_items_book') {
        return res.status(409).json({
          error: 'Книгу не можна видалити: вона міститься у замовленнях',
        });
      }
      return res.status(400).json({ error: 'Пов\'язаний запис (автор, жанр, клієнт або книга) не існує' });
    case '23505':
      switch (db.constraint) {
        case 'uq_users_username':
          return res.status(409).json({ error: 'Користувач з таким логіном вже існує' });
        case 'uq_books_isbn':
          return res.status(409).json({ error: 'Книга з таким ISBN вже існує' });
        case 'uq_customers_phone':
          return res.status(409).json({ error: 'Клієнт з таким телефоном вже існує' });
        case 'uq_customers_email':
          return res.status(409).json({ error: 'Клієнт з таким email вже існує' });
        case 'uq_authors_person':
          return res.status(409).json({ error: 'Такий автор (ім\'я, прізвище, країна) вже існує' });
        default:
          return res.status(409).json({ error: 'Запис з такими унікальними даними вже існує' });
      }
    case '23514':
      return res.status(400).json({ error: 'Порушено обмеження цілісності даних (CHECK)' });
    case '23502':
      return res.status(400).json({ error: 'Не заповнено обов\'язкове поле' });
    default:
      break;
  }

  if (err instanceof ValidationError) {
    return res.status(400).json({ error: 'Некоректні дані: ' + err.message });
  }

  return res.status(500).json({ error: 'Внутрішня помилка сервера' });
}

// ---------------------------------------------------------------------------
// API: автентифікація (відкриті ендпоінти)
// ---------------------------------------------------------------------------

app.post('/api/login', async (req, res) => {
  const username = str(req.body && req.body.username).toLowerCase();
  const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';

  if (!username || !password) {
    return res.status(400).json({ error: 'Введіть логін і пароль' });
  }

  try {
    // Перевірка bcrypt-хеша виконується в СУБД: password = crypt(:пароль, password)
    const user = await User.findOne({
      attributes: ['id', 'username', 'role'],
      where: {
        [Op.and]: [
          { username },
          sequelize.where(col('password'), fn('crypt', password, col('password'))),
        ],
      },
    });

    if (!user) {
      return res.status(401).json({ error: 'Невірний логін або пароль' });
    }

    const sessionUser = { id: user.id, username: user.username, role: user.role };
    const token = createSession(sessionUser);
    res.json({ token, user: sessionUser });
  } catch (err) {
    handleError(err, res);
  }
});

app.post('/api/register', async (req, res) => {
  const { error, value } = validateRegistration(req.body);
  if (error) {
    return res.status(400).json({ error });
  }

  try {
    // Самореєстрація завжди створює користувача з роллю manager;
    // пароль хешується bcrypt-ом на боці СУБД (pgcrypto)
    const created = await User.create({
      username: value.username,
      password: fn('crypt', value.password, fn('gen_salt', 'bf', 10)),
      role: 'manager',
    });

    const sessionUser = { id: created.id, username: value.username, role: 'manager' };
    const token = createSession(sessionUser);
    res.status(201).json({ token, user: sessionUser });
  } catch (err) {
    handleError(err, res);
  }
});

// ---------------------------------------------------------------------------
// Усі подальші маршрути /api/* вимагають авторизації
// ---------------------------------------------------------------------------

app.use('/api', requireAuth);

app.get('/api/me', (req, res) => {
  res.json(req.user);
});

app.post('/api/logout', (req, res) => {
  sessions.delete(req.token);
  res.json({ message: 'Ви вийшли з системи' });
});

// ---------------------------------------------------------------------------
// API: статистика
// ---------------------------------------------------------------------------

app.get('/api/stats', async (req, res) => {
  try {
    const [bookStats, orderStats, ordersCount, lowStock] = await Promise.all([
      Book.findOne({
        attributes: [
          [fn('COUNT', col('id')), 'total_books'],
          [fn('COALESCE', fn('SUM', col('stock_quantity')), 0), 'total_copies'],
          [fn('COALESCE', fn('SUM', literal('"price" * "stock_quantity"')), 0), 'total_value'],
        ],
        raw: true,
      }),
      Order.findOne({
        attributes: [[fn('COALESCE', fn('SUM', col('total_amount')), 0), 'orders_revenue']],
        where: { status: { [Op.ne]: 'cancelled' } },
        raw: true,
      }),
      Order.count(),
      Book.findAll({
        attributes: ['id', 'title', 'stock_quantity'],
        where: { stock_quantity: { [Op.lte]: 5 } },
        order: [['stock_quantity', 'ASC'], ['title', 'ASC']],
        limit: 10,
        raw: true,
      }),
    ]);

    res.json({
      total_books: Number(bookStats.total_books),
      total_copies: Number(bookStats.total_copies),
      total_value: Number(bookStats.total_value),
      orders_count: ordersCount,
      orders_revenue: Number(orderStats.orders_revenue),
      low_stock: lowStock,
    });
  } catch (err) {
    handleError(err, res);
  }
});

// ---------------------------------------------------------------------------
// API: довідники (автори, жанри, клієнти)
// ---------------------------------------------------------------------------

app.get('/api/authors', async (req, res) => {
  try {
    const authors = await Author.findAll({
      order: [['last_name', 'ASC'], ['first_name', 'ASC']],
    });
    res.json(authors.map((a) => a.toJSON()));
  } catch (err) {
    handleError(err, res);
  }
});

app.post('/api/authors', async (req, res) => {
  const { error, value } = validateAuthor(req.body);
  if (error) {
    return res.status(400).json({ error });
  }

  try {
    const author = await Author.create(value);
    res.status(201).json(author.toJSON());
  } catch (err) {
    handleError(err, res);
  }
});

app.get('/api/genres', async (req, res) => {
  try {
    const genres = await Genre.findAll({
      attributes: ['id', 'name', 'description'],
      order: [['name', 'ASC']],
      raw: true,
    });
    res.json(genres);
  } catch (err) {
    handleError(err, res);
  }
});

app.get('/api/customers', async (req, res) => {
  try {
    const customers = await Customer.findAll({
      attributes: ['id', 'full_name', 'phone', 'email', 'address'],
      order: [['full_name', 'ASC']],
      raw: true,
    });
    res.json(customers);
  } catch (err) {
    handleError(err, res);
  }
});

app.post('/api/customers', async (req, res) => {
  const { error, value } = validateCustomer(req.body);
  if (error) {
    return res.status(400).json({ error });
  }

  try {
    const customer = await Customer.create(value);
    res.status(201).json(customer.toJSON());
  } catch (err) {
    handleError(err, res);
  }
});

// ---------------------------------------------------------------------------
// API: книги
// ---------------------------------------------------------------------------

app.get('/api/books', async (req, res) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    const options = {
      include: BOOK_INCLUDE,
      order: [['id', 'ASC']],
    };

    if (search) {
      const pattern = `%${escapeLike(search)}%`;
      options.where = {
        [Op.or]: [
          { title: { [Op.iLike]: pattern } },
          { isbn: { [Op.iLike]: pattern } },
          sequelize.where(
            fn('concat', col('author.first_name'), ' ', col('author.last_name')),
            { [Op.iLike]: pattern }
          ),
          { '$genre.name$': { [Op.iLike]: pattern } },
        ],
      };
    }

    const books = await Book.findAll(options);
    res.json(books.map(serializeBook));
  } catch (err) {
    handleError(err, res);
  }
});

app.post('/api/books', async (req, res) => {
  const { error, value } = validateBook(req.body);
  if (error) {
    return res.status(400).json({ error });
  }

  try {
    const created = await Book.create(value);
    res.status(201).json(await getBookById(created.id));
  } catch (err) {
    handleError(err, res);
  }
});

app.put('/api/books/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'Некоректний ідентифікатор книги' });
  }

  const { error, value } = validateBook(req.body);
  if (error) {
    return res.status(400).json({ error });
  }

  try {
    const book = await Book.findByPk(id);
    if (!book) {
      return res.status(404).json({ error: 'Книгу не знайдено' });
    }

    await book.update(value);
    res.json(await getBookById(id));
  } catch (err) {
    handleError(err, res);
  }
});

// Видаляти книги може лише адміністратор
app.delete('/api/books/:id', requireRole('admin'), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'Некоректний ідентифікатор книги' });
  }

  try {
    const deleted = await Book.destroy({ where: { id } });

    if (deleted === 0) {
      return res.status(404).json({ error: 'Книгу не знайдено' });
    }

    res.json({ message: 'Книгу успішно видалено' });
  } catch (err) {
    handleError(err, res);
  }
});

// ---------------------------------------------------------------------------
// API: замовлення (orders + order_items)
// ---------------------------------------------------------------------------

app.get('/api/orders', async (req, res) => {
  try {
    const orders = await Order.findAll({
      include: ORDER_INCLUDE,
      order: [['order_date', 'DESC'], ['id', 'DESC'], ITEMS_SORT],
    });
    res.json(orders.map(serializeOrder));
  } catch (err) {
    handleError(err, res);
  }
});

/*
 * Тіло запиту:
 * {
 *   "customer_id": 1,
 *   "items": [ { "book_id": 1, "quantity": 2 }, { "book_id": 4, "quantity": 1 } ]
 * }
 * Ціна позиції береться з таблиці books на момент замовлення,
 * а orders.total_amount автоматично розраховує тригер trg_order_items_total.
 */
app.post('/api/orders', async (req, res) => {
  const body = req.body || {};

  const customerId = parseId(body.customer_id);
  if (!customerId) {
    return res.status(400).json({ error: 'Потрібно вибрати клієнта' });
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return res.status(400).json({ error: 'Додайте до замовлення щонайменше одну позицію' });
  }
  if (body.items.length > 50) {
    return res.status(400).json({ error: 'Замовлення не може містити більше 50 позицій' });
  }

  // Об'єднуємо дублікати книг та перевіряємо кількості
  const wanted = new Map();
  for (const item of body.items) {
    const bookId = parseId(item && item.book_id);
    const quantity = Number(item && item.quantity);

    if (!bookId) {
      return res.status(400).json({ error: 'У кожній позиції потрібно вибрати книгу' });
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) {
      return res.status(400).json({ error: 'Кількість у кожній позиції має бути цілим числом від 1 до 10000' });
    }
    wanted.set(bookId, (wanted.get(bookId) || 0) + quantity);
  }

  const bookIds = [...wanted.keys()].sort((a, b) => a - b);

  try {
    // Керована транзакція: успішне завершення колбека = COMMIT, виняток = ROLLBACK
    const orderId = await sequelize.transaction(async (t) => {
      const customer = await Customer.findByPk(customerId, {
        attributes: ['id'],
        transaction: t,
      });
      if (!customer) {
        throw new HttpError(404, 'Клієнта не знайдено');
      }

      // SELECT ... FOR UPDATE у стабільному порядку: паралельні замовлення
      // не «перепродадуть» залишок і не спричинять взаємоблокування
      const books = await Book.findAll({
        where: { id: bookIds },
        order: [['id', 'ASC']],
        transaction: t,
        lock: t.LOCK.UPDATE,
      });

      if (books.length !== bookIds.length) {
        throw new HttpError(404, 'Одну або кілька книг не знайдено');
      }

      for (const book of books) {
        const quantity = wanted.get(book.id);
        if (book.stock_quantity < quantity) {
          throw new HttpError(
            409,
            `Недостатньо примірників «${book.title}» на складі (доступно: ${book.stock_quantity})`
          );
        }
      }

      const order = await Order.create(
        { customer_id: customerId, status: 'new' },
        { transaction: t }
      );

      for (const book of books) {
        const quantity = wanted.get(book.id);

        await book.decrement('stock_quantity', { by: quantity, transaction: t });

        // Після кожної вставки тригер перераховує orders.total_amount
        await OrderItem.create(
          {
            order_id: order.id,
            book_id: book.id,
            quantity,
            price: book.price,
          },
          { transaction: t }
        );
      }

      return order.id;
    });

    res.status(201).json(await getOrderById(orderId));
  } catch (err) {
    handleError(err, res);
  }
});

// ---------------------------------------------------------------------------
// Обробка невідомих API-маршрутів та помилок
// ---------------------------------------------------------------------------

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Ендпоінт не знайдено' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Некоректний JSON у тілі запиту' });
  }
  console.error('Необроблена помилка:', err);
  res.status(500).json({ error: 'Внутрішня помилка сервера' });
});

// ---------------------------------------------------------------------------
// Запуск сервера: спочатку перевіряємо з'єднання з БД через ORM
// ---------------------------------------------------------------------------

let server = null;

(async function start() {
  try {
    await sequelize.authenticate();
    console.log('Підключення до PostgreSQL через Sequelize ORM встановлено');

    // Перевіряємо, чи вже створена таблиця users; якщо ні — виконуємо init.sql
    const [tables] = await sequelize.query(`SELECT to_regclass('public.users') AS tbl;`);
    if (!tables[0].tbl) {
      const initSql = fs.readFileSync(path.join(__dirname, 'init.sql'), 'utf8');
      await sequelize.query(initSql);
      console.log('Схему бази даних та початкові дані з init.sql успішно завантажено');
    }

    server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`Сервер запущено на порту ${PORT}`);
    });
  } catch (err) {
    console.error('Не вдалося підключитися до БД:', err.message);
    process.exit(1);
  }
})();

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);