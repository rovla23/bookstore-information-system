'use strict';


const { Sequelize, DataTypes } = require('sequelize');

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('Помилка: не задано змінну оточення DATABASE_URL');
  process.exit(1);
}

const sequelize = new Sequelize(DATABASE_URL, {
  dialect: 'postgres',
  // SQL_LOG=1 виводить усі SQL-запити, які генерує ORM (зручно для скріншотів у курсовій)
  logging: process.env.SQL_LOG === '1' ? console.log : false,
  define: {
    timestamps: false,
    freezeTableName: true,
  },
  pool: {
    max: 10,
    min: 0,
    acquire: 30000,
    idle: 10000,
  },
});

// ---------------------------------------------------------------------------
// Моделі
// ---------------------------------------------------------------------------

const Author = sequelize.define('Author', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  first_name: { type: DataTypes.STRING(80), allowNull: false },
  last_name: { type: DataTypes.STRING(80), allowNull: false },
  country: { type: DataTypes.STRING(100), allowNull: false },
  bio: { type: DataTypes.TEXT, allowNull: true },
  // Віртуальне поле: у таблиці його немає, обчислюється на льоту
  full_name: {
    type: DataTypes.VIRTUAL,
    get() {
      return `${this.getDataValue('first_name')} ${this.getDataValue('last_name')}`;
    },
  },
}, { tableName: 'authors' });

const Genre = sequelize.define('Genre', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  name: { type: DataTypes.STRING(100), allowNull: false },
  description: { type: DataTypes.TEXT, allowNull: true },
}, { tableName: 'genres' });

const Book = sequelize.define('Book', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  title: { type: DataTypes.STRING(200), allowNull: false },
  isbn: { type: DataTypes.STRING(17), allowNull: false },
  publication_year: { type: DataTypes.INTEGER, allowNull: false },
  price: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  stock_quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  author_id: { type: DataTypes.INTEGER, allowNull: false },
  genre_id: { type: DataTypes.INTEGER, allowNull: false },
}, { tableName: 'books' });

const Customer = sequelize.define('Customer', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  full_name: { type: DataTypes.STRING(150), allowNull: false },
  phone: { type: DataTypes.STRING(20), allowNull: false },
  email: { type: DataTypes.STRING(150), allowNull: false },
  address: { type: DataTypes.STRING(255), allowNull: false },
}, { tableName: 'customers' });

const Order = sequelize.define('Order', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  customer_id: { type: DataTypes.INTEGER, allowNull: false },
  order_date: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
  },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'new' },
  // Значення перераховує тригер БД (trg_order_items_total) після змін в order_items
  total_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
}, { tableName: 'orders' });

const OrderItem = sequelize.define('OrderItem', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  order_id: { type: DataTypes.INTEGER, allowNull: false },
  book_id: { type: DataTypes.INTEGER, allowNull: false },
  quantity: { type: DataTypes.INTEGER, allowNull: false },
  price: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
}, { tableName: 'order_items' });

const User = sequelize.define('User', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  username: { type: DataTypes.STRING(30), allowNull: false },
  // Зберігається bcrypt-хеш (pgcrypto), а не відкритий пароль
  password: { type: DataTypes.STRING(100), allowNull: false },
  role: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'manager' },
  created_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
  },
}, { tableName: 'users' });

// ---------------------------------------------------------------------------
// Зв'язки між моделями (відповідають FOREIGN KEY з init.sql)
// ---------------------------------------------------------------------------

// authors 1 — N books
Author.hasMany(Book, { foreignKey: 'author_id', as: 'books', onDelete: 'CASCADE' });
Book.belongsTo(Author, { foreignKey: 'author_id', as: 'author' });

// genres 1 — N books
Genre.hasMany(Book, { foreignKey: 'genre_id', as: 'books', onDelete: 'CASCADE' });
Book.belongsTo(Genre, { foreignKey: 'genre_id', as: 'genre' });

// customers 1 — N orders
Customer.hasMany(Order, { foreignKey: 'customer_id', as: 'orders', onDelete: 'CASCADE' });
Order.belongsTo(Customer, { foreignKey: 'customer_id', as: 'customer' });

// orders 1 — N order_items
Order.hasMany(OrderItem, { foreignKey: 'order_id', as: 'items', onDelete: 'CASCADE' });
OrderItem.belongsTo(Order, { foreignKey: 'order_id', as: 'order' });

// books 1 — N order_items (RESTRICT: книгу з замовлень видалити не можна)
Book.hasMany(OrderItem, { foreignKey: 'book_id', as: 'orderItems', onDelete: 'RESTRICT' });
OrderItem.belongsTo(Book, { foreignKey: 'book_id', as: 'book' });

module.exports = {
  sequelize,
  Author,
  Genre,
  Book,
  Customer,
  Order,
  OrderItem,
  User,
};