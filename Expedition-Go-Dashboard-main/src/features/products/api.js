import api from "@/lib/axios";

/**
 * Create a new product/tour
 * @param {Object} payload - The product payload from buildProductPayload()
 * @returns {Promise} Axios response
 */
export const createProduct = (payload) => api.post("/tours", payload);

/**
 * Update an existing product/tour
 * @param {string} id - Product ID
 * @param {Object} payload - The product payload from buildProductPayload()
 * @returns {Promise} Axios response
 */
export const updateProduct = (id, payload) => api.patch(`/tours/${id}`, payload);

/**
 * Fetch a single product/tour by ID
 * @param {string} id - Product ID
 * @returns {Promise} Axios response
 */
export const getProduct = (id) => api.get(`/tours/${id}`);

/**
 * List all products/tours
 * @param {Object} params - Query params (page, limit, status, etc.)
 * @returns {Promise} Axios response
 */
export const listProducts = (params = {}) => api.get("/tours", { params });

/**
 * Delete a product/tour
 * @param {string} id - Product ID
 * @returns {Promise} Axios response
 */
export const deleteProduct = (id) => api.delete(`/tours/${id}`);
