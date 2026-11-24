-- =====================================================
-- Інформаційна система книжкового магазину
-- PostgreSQL 15 — DDL та початкові дані (версія 3)
-- Таблиці: authors, genres, books, customers,
--          orders, order_items, users
-- =====================================================

SET client_encoding = 'UTF8';

-- Розширення для хешування паролів (bcrypt)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS books CASCADE;
DROP TABLE IF EXISTS customers CASCADE;
DROP TABLE IF EXISTS genres CASCADE;
DROP TABLE IF EXISTS authors CASCADE;
DROP FUNCTION IF EXISTS fn_recalc_order_total() CASCADE;

-- -----------------------------------------------------
-- Автори
-- -----------------------------------------------------
CREATE TABLE authors (
    id          SERIAL PRIMARY KEY,
    first_name  VARCHAR(80)  NOT NULL,
    last_name   VARCHAR(80)  NOT NULL,
    country     VARCHAR(100) NOT NULL,
    bio         TEXT,
    CONSTRAINT uq_authors_person UNIQUE (first_name, last_name, country)
);

-- -----------------------------------------------------
-- Жанри
-- -----------------------------------------------------
CREATE TABLE genres (
    id           SERIAL PRIMARY KEY,
    name         VARCHAR(100) NOT NULL,
    description  TEXT,
    CONSTRAINT uq_genres_name UNIQUE (name)
);

-- -----------------------------------------------------
-- Книги
-- -----------------------------------------------------
CREATE TABLE books (
    id                SERIAL PRIMARY KEY,
    title             VARCHAR(200)   NOT NULL,
    isbn              VARCHAR(17)    NOT NULL,
    publication_year  INTEGER        NOT NULL,
    price             NUMERIC(10, 2) NOT NULL,
    stock_quantity    INTEGER        NOT NULL DEFAULT 0,
    author_id         INTEGER        NOT NULL,
    genre_id          INTEGER        NOT NULL,
    CONSTRAINT uq_books_isbn UNIQUE (isbn),
    CONSTRAINT fk_books_author
        FOREIGN KEY (author_id) REFERENCES authors (id) ON DELETE CASCADE,
    CONSTRAINT fk_books_genre
        FOREIGN KEY (genre_id) REFERENCES genres (id) ON DELETE CASCADE,
    CONSTRAINT chk_books_isbn  CHECK (isbn ~ '^[0-9X-]{10,17}$'),
    CONSTRAINT chk_books_year  CHECK (publication_year BETWEEN 1450 AND 2100),
    CONSTRAINT chk_books_price CHECK (price >= 0),
    CONSTRAINT chk_books_stock CHECK (stock_quantity >= 0)
);

CREATE INDEX idx_books_author ON books (author_id);
CREATE INDEX idx_books_genre  ON books (genre_id);
CREATE INDEX idx_books_title  ON books (title);

-- -----------------------------------------------------
-- Клієнти
-- -----------------------------------------------------
CREATE TABLE customers (
    id         SERIAL PRIMARY KEY,
    full_name  VARCHAR(150) NOT NULL,
    phone      VARCHAR(20)  NOT NULL,
    email      VARCHAR(150) NOT NULL,
    address    VARCHAR(255) NOT NULL,
    CONSTRAINT uq_customers_phone UNIQUE (phone),
    CONSTRAINT uq_customers_email UNIQUE (email),
    CONSTRAINT chk_customers_phone CHECK (phone ~ '^\+?[0-9]{7,15}$'),
    CONSTRAINT chk_customers_email CHECK (email LIKE '%_@_%._%')
);

-- -----------------------------------------------------
-- Замовлення
-- total_amount підтримується тригером на order_items
-- -----------------------------------------------------
CREATE TABLE orders (
    id            SERIAL PRIMARY KEY,
    customer_id   INTEGER        NOT NULL,
    order_date    TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status        VARCHAR(20)    NOT NULL DEFAULT 'new',
    total_amount  NUMERIC(12, 2) NOT NULL DEFAULT 0,
    CONSTRAINT fk_orders_customer
        FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE,
    CONSTRAINT chk_orders_status
        CHECK (status IN ('new', 'processing', 'shipped', 'completed', 'cancelled')),
    CONSTRAINT chk_orders_total CHECK (total_amount >= 0)
);

CREATE INDEX idx_orders_customer ON orders (customer_id);
CREATE INDEX idx_orders_date     ON orders (order_date DESC);

-- -----------------------------------------------------
-- Позиції замовлення
-- price — ціна одного примірника на момент замовлення
-- book_id: RESTRICT, щоб видалення книги не спотворювало історію замовлень
-- -----------------------------------------------------
CREATE TABLE order_items (
    id        SERIAL PRIMARY KEY,
    order_id  INTEGER        NOT NULL,
    book_id   INTEGER        NOT NULL,
    quantity  INTEGER        NOT NULL,
    price     NUMERIC(10, 2) NOT NULL,
    CONSTRAINT fk_items_order
        FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
    CONSTRAINT fk_items_book
        FOREIGN KEY (book_id) REFERENCES books (id) ON DELETE RESTRICT,
    CONSTRAINT uq_items_order_book UNIQUE (order_id, book_id),
    CONSTRAINT chk_items_quantity CHECK (quantity > 0),
    CONSTRAINT chk_items_price    CHECK (price >= 0)
);

CREATE INDEX idx_items_order ON order_items (order_id);
CREATE INDEX idx_items_book  ON order_items (book_id);

-- -----------------------------------------------------
-- Тригер: автоматичний розрахунок orders.total_amount
-- -----------------------------------------------------
CREATE FUNCTION fn_recalc_order_total() RETURNS trigger AS $$
DECLARE
    target_order INTEGER;
BEGIN
    IF TG_OP = 'DELETE' THEN
        target_order := OLD.order_id;
    ELSE
        target_order := NEW.order_id;
    END IF;

    UPDATE orders
       SET total_amount = COALESCE(
             (SELECT SUM(quantity * price) FROM order_items WHERE order_id = target_order),
             0)
     WHERE id = target_order;

    -- Якщо позицію перенесли в інше замовлення, перераховуємо й старе
    IF TG_OP = 'UPDATE' AND OLD.order_id <> NEW.order_id THEN
        UPDATE orders
           SET total_amount = COALESCE(
                 (SELECT SUM(quantity * price) FROM order_items WHERE order_id = OLD.order_id),
                 0)
         WHERE id = OLD.order_id;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_order_items_total
AFTER INSERT OR UPDATE OR DELETE ON order_items
FOR EACH ROW EXECUTE FUNCTION fn_recalc_order_total();

-- -----------------------------------------------------
-- Користувачі системи
-- password зберігає bcrypt-хеш, а не відкритий пароль
-- -----------------------------------------------------
CREATE TABLE users (
    id          SERIAL PRIMARY KEY,
    username    VARCHAR(30)  NOT NULL,
    password    VARCHAR(100) NOT NULL,
    role        VARCHAR(20)  NOT NULL DEFAULT 'manager',
    created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_users_username UNIQUE (username),
    CONSTRAINT chk_users_role CHECK (role IN ('admin', 'manager')),
    CONSTRAINT chk_users_username_len CHECK (char_length(username) >= 3),
    CONSTRAINT chk_users_username_lower CHECK (username = lower(username))
);

-- =====================================================
-- Початкові тестові дані
-- =====================================================

INSERT INTO authors (first_name, last_name, country, bio) VALUES
    ('Тарас',   'Шевченко', 'Україна',
     'Український поет, прозаїк, художник і мислитель, символ національного відродження XIX століття.'),
    ('Леся',    'Українка', 'Україна',
     'Українська письменниця, поетеса і драматургка, авторка «Лісової пісні».'),
    ('Іван',    'Франко',   'Україна',
     'Письменник, поет, перекладач, учений і громадський діяч, автор історичної повісті «Захар Беркут».'),
    ('Джордж',  'Орвелл',   'Великобританія',
     'Англійський письменник і публіцист, автор антиутопії «1984» та алегорії «Скотний двір».'),
    ('Стівен',  'Кінг',     'США',
     'Американський письменник, майстер літератури жахів і психологічного трилера.');

INSERT INTO genres (name, description) VALUES
    ('Поезія',           'Поетичні збірки, вірші та поеми'),
    ('Драма',            'Драматичні твори та п''єси для читання і сцени'),
    ('Історичний роман', 'Прозові твори, дія яких відбувається в минулому'),
    ('Антиутопія',       'Художня література про тоталітарні та негативні моделі суспільства'),
    ('Жахи',             'Література жахів, містики та психологічного напруження');

INSERT INTO books (title, isbn, publication_year, price, stock_quantity, author_id, genre_id) VALUES
    ('Кобзар',        '978-966-10-0001-1', 1840, 350.00, 25, 1, 1),
    ('Лісова пісня',  '978-966-10-0002-2', 1911, 220.50, 15, 2, 2),
    ('Захар Беркут',  '978-966-10-0003-3', 1883, 190.00,  4, 3, 3),
    ('1984',          '978-966-10-0004-4', 1949, 275.00, 30, 4, 4),
    ('Сяйво',         '978-966-10-0005-5', 1977, 320.00, 18, 5, 5),
    ('Мойсей',        '978-966-10-0006-6', 1905, 260.00,  3, 3, 1),
    ('Скотний двір',  '978-966-10-0007-7', 1945, 180.00, 22, 4, 4);

INSERT INTO customers (full_name, phone, email, address) VALUES
    ('Олександр Петренко',  '+380501112233', 'o.petrenko@example.com',   'м. Київ, вул. Хрещатик, 10, кв. 5'),
    ('Марія Коваленко',     '+380672223344', 'm.kovalenko@example.com',  'м. Львів, пр. Свободи, 22'),
    ('Андрій Шевчук',       '+380933334455', 'a.shevchuk@example.com',   'м. Одеса, вул. Дерибасівська, 7, кв. 12'),
    ('Наталія Бондаренко',  '+380634445566', 'n.bondarenko@example.com', 'м. Харків, вул. Сумська, 41'),
    ('Ігор Мельник',        '+380505556677', 'i.melnyk@example.com',     'м. Дніпро, пр. Яворницького, 15, кв. 8');

-- Тестові облікові записи:
--   admin    / admin123    (роль admin)
--   manager  / manager123  (роль manager)
--   olena    / olena123    (роль manager)
--   petro    / petro123    (роль manager)
INSERT INTO users (username, password, role) VALUES
    ('admin',   crypt('admin123',   gen_salt('bf', 10)), 'admin'),
    ('manager', crypt('manager123', gen_salt('bf', 10)), 'manager'),
    ('olena',   crypt('olena123',   gen_salt('bf', 10)), 'manager'),
    ('petro',   crypt('petro123',   gen_salt('bf', 10)), 'manager');

-- total_amount заповнить тригер після вставки позицій
INSERT INTO orders (customer_id, order_date, status) VALUES
    (1, '2026-10-05 12:30:00', 'completed'),
    (2, '2026-10-08 16:45:00', 'shipped'),
    (3, '2026-10-12 09:15:00', 'processing'),
    (4, '2026-10-17 18:20:00', 'new'),
    (5, '2026-10-20 11:05:00', 'cancelled');

INSERT INTO order_items (order_id, book_id, quantity, price) VALUES
    (1, 1, 2, 330.00),   -- Кобзар (на момент замовлення коштував 330 грн)
    (1, 4, 1, 275.00),   -- 1984
    (2, 2, 1, 220.50),   -- Лісова пісня
    (3, 3, 1, 190.00),   -- Захар Беркут
    (3, 5, 1, 320.00),   -- Сяйво
    (4, 7, 2, 180.00),   -- Скотний двір
    (5, 6, 1, 260.00),   -- Мойсей
    (5, 1, 1, 350.00);   -- Кобзар