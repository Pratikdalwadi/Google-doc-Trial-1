/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { GoogleGenAI, Type } from '@google/genai';

// Fix: Declare pdfjsLib to resolve "Cannot find name 'pdfjsLib'" error.
declare var pdfjsLib: any;

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

const fileUpload = document.getElementById('file-upload') as HTMLInputElement;
const fileNameSpan = document.getElementById('file-name');
const extractButton = document.getElementById(
  'extract-button',
) as HTMLButtonElement;
const markdownResultsContainer = document.getElementById('markdown-results');
const jsonResultsContainer = document.getElementById('json-results');
const loadingSpinner = document.getElementById('loading-spinner');
const previewContainer = document.getElementById('preview-container');
const tabsContainer = document.querySelector('.tabs');
const tabButtons = document.querySelectorAll('.tab-button');
const tabPanels = document.querySelectorAll('.tab-panel');

let file: File | null = null;
let fileData: {
  mimeType: string;
  data: string;
} | null = null;
let pageDimensions: { width: number; height: number }[] = [];

// The schema is now a constant to be used for both the API call and the UI display.
const EXTRACTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    extracted_elements: {
      type: Type.ARRAY,
      description: 'An array of all elements extracted from the document.',
      items: {
        type: Type.OBJECT,
        properties: {
          type: {
            type: Type.STRING,
            description:
              "The type of element. Must be one of: 'field', 'field_group', 'table', 'paragraph', 'checkbox', 'logo', 'figure', 'marginalia', 'attestation'.",
          },
          label: {
            type: Type.STRING,
            description:
              'The label or key for a field, or a title for a table/paragraph.',
          },
          value: {
            type: Type.STRING,
            description:
              "The extracted text value or a description for visual elements. Not used for 'table' or 'field_group' types.",
          },
          page: {
            type: Type.INTEGER,
            description:
              'The page number where the element was found (starting from 1).',
          },
          bounding_box: {
            type: Type.OBJECT,
            properties: {
              x: { type: Type.NUMBER },
              y: { type: Type.NUMBER },
              width: { type: Type.NUMBER },
              height: { type: Type.NUMBER },
            },
            description:
              "Normalized coordinates of the element on the page. For a 'field_group', this should encompass all fields in the group.",
          },
          table_data: {
            type: Type.OBJECT,
            description:
              "Contains header and row data. Only present if type is 'table'.",
            properties: {
              headers: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'The column headers of the table.',
              },
              rows: {
                type: Type.ARRAY,
                items: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description:
                    "An array of strings representing a single row's cells.",
                },
                description: 'The data rows of the table.',
              },
            },
          },
          fields: {
            type: Type.ARRAY,
            description:
              "An array of individual fields. Only present if type is 'field_group'.",
            items: {
              type: Type.OBJECT,
              properties: {
                label: { type: Type.STRING },
                value: { type: Type.STRING },
              },
            },
          },
        },
      },
    },
  },
};

// --- Event Listeners ---

fileUpload.addEventListener('change', async (event) => {
  const target = event.target as HTMLInputElement;
  if (target.files && target.files[0]) {
    file = target.files[0];
    fileNameSpan.textContent = file.name;
    extractButton.disabled = false;
    await renderPreview(file);
  } else {
    fileNameSpan.textContent = 'No file chosen';
    extractButton.disabled = true;
    clearPreview();
  }
});

extractButton.addEventListener('click', async () => {
  if (!file || !fileData) return;

  loadingSpinner.classList.remove('hidden');
  clearResults();
  clearBoundingBoxes();

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: {
        parts: [
          {
            text: `You are an Agentic Document Extraction system. Your task is to perform a comprehensive analysis of the uploaded document and return structured, accurate data with precise visual traceability.

**Core Instructions:**
1.  **Comprehensive Extraction:** You must extract ALL data from the document. Leave nothing out.
2.  **Sequential Ordering:** The elements in the final 'extracted_elements' array must be sorted to strictly follow the top-to-bottom reading order of the source document.
3.  **Pixel-Perfect Bounding Boxes:** This is critical. For every single element, you MUST provide a bounding box that is as precise as possible. It must tightly and completely enclose the entire logical block, leaving no extra padding and not cutting anything off. The accuracy of these boxes is paramount as they are used to visually highlight elements for the user. Think of it as drawing a perfect, snug rectangle around the element. The coordinates (x, y, width, height) must be normalized from 0 to 1 relative to the page size.
4.  **Element Categorization:** Classify each extracted element into one of the following types: 'field', 'field_group', 'table', 'paragraph', 'checkbox', 'logo', 'figure', 'marginalia', 'attestation'.

**Type-Specific Instructions:**
-   **field:** A simple key-value pair.
-   **field_group:** A set of logically related fields (e.g., a patient information block or an address block). The 'bounding_box' for a group must encompass all of its child fields.
-   **paragraph:** A block of free-form text without a distinct key-value structure.
-   **table:** Structured data in rows and columns. Populate the 'table_data' object.
-   **logo / figure:** For visual elements like logos or images, set the type accordingly and provide a detailed description of the visual content in the 'value' field.
-   **marginalia:** Text outside the main content block, like page numbers or headers/footers.
-   **attestation:** Signature blocks or electronic signature confirmations.

The output must be a single, valid JSON object that strictly adheres to the provided schema, with no additional text or explanations.`,
          },
          {
            inlineData: fileData,
          },
        ],
      },
      config: {
        responseMimeType: 'application/json',
        responseSchema: EXTRACTION_SCHEMA,
      },
    });

    const parsedResult = JSON.parse(response.text);
    displayMarkdownResults(parsedResult.extracted_elements);
    displayJsonResults(parsedResult);
    setActiveTab('markdown');
  } catch (error) {
    console.error('Error extracting data:', error);
    markdownResultsContainer.innerHTML =
      '<p class="error">Failed to extract data. The model may not have been able to process this document. Please try again with a clearer document.</p>';
    setActiveTab('markdown');
  } finally {
    loadingSpinner.classList.add('hidden');
  }
});

tabsContainer.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (target.classList.contains('tab-button')) {
    const tabName = target.dataset.tab;
    // Fix: Ensure tabName is a string before calling setActiveTab, which requires a string argument.
    if (tabName) {
      setActiveTab(tabName);
    }
  }
});

// --- UI Functions ---

function setActiveTab(tabName: string) {
  tabButtons.forEach((button) => {
    // Fix: Cast 'button' to HTMLElement to access the 'dataset' property.
    // This resolves the "Property 'dataset' does not exist on type 'Element'" error,
    // as querySelectorAll returns a list of generic Elements.
    button.classList.toggle(
      'active',
      (button as HTMLElement).dataset.tab === tabName,
    );
  });
  tabPanels.forEach((panel) => {
    panel.classList.toggle('active', panel.id === `${tabName}-tab`);
  });
}

async function renderPreview(file: File) {
  clearPreview();
  const reader = new FileReader();

  reader.onload = async (e) => {
    const result = e.target.result as string;
    const base64Data = result.split(',')[1];
    fileData = {
      mimeType: file.type,
      data: base64Data,
    };

    if (file.type === 'application/pdf') {
      const pdf = await pdfjsLib.getDocument({ data: atob(base64Data) })
        .promise;

      for (let i = 1; i <= pdf.numPages; i++) {
        const canvas = document.createElement('canvas');
        canvas.dataset.pageNumber = String(i);

        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1.5 });
        const context = canvas.getContext('2d');
        canvas.height = viewport.height;
        canvas.width = viewport.width;

        pageDimensions.push({
          width: viewport.width,
          height: viewport.height,
        });

        await page.render({ canvasContext: context, viewport: viewport })
          .promise;
        previewContainer.appendChild(canvas);
      }
    } else {
      const imagePreview = document.createElement('img');
      imagePreview.src = result;
      imagePreview.alt = 'Image preview';
      imagePreview.dataset.pageNumber = '1';

      imagePreview.onload = () => {
        pageDimensions.push({
          width: imagePreview.naturalWidth,
          height: imagePreview.naturalHeight,
        });
      };
      previewContainer.appendChild(imagePreview);
    }
  };
  reader.readAsDataURL(file);
}

function displayMarkdownResults(elements: any[]) {
  markdownResultsContainer.innerHTML = ''; // Clear previous results
  if (!elements || elements.length === 0) {
    markdownResultsContainer.innerHTML =
      '<p>No structured data was extracted. The document might be empty or in an unsupported format.</p>';
    return;
  }

  elements.forEach((element) => {
    const resultItem = document.createElement('div');
    resultItem.className = 'result-item';
    resultItem.addEventListener('mouseover', () => drawBoundingBox(element));
    resultItem.addEventListener('mouseout', clearBoundingBoxes);

    switch (element.type) {
      case 'field':
      case 'checkbox':
      case 'paragraph':
      case 'logo':
      case 'figure':
      case 'marginalia':
      case 'attestation':
        resultItem.classList.add('field-item', `${element.type}-item`);
        resultItem.innerHTML = `
          <span class="result-label">${element.label || element.type}</span>
          <span class="result-value">${element.value || 'N/A'}</span>
        `;
        break;

      case 'field_group':
        resultItem.classList.add('field-group-item');
        const groupTitle = document.createElement('h3');
        groupTitle.textContent = element.label || 'Field Group';
        resultItem.appendChild(groupTitle);

        if (element.fields && element.fields.length > 0) {
          const fieldsList = document.createElement('div');
          fieldsList.className = 'field-group-fields';
          element.fields.forEach(
            (field: { label: string; value: string }) => {
              const fieldDiv = document.createElement('div');
              fieldDiv.className = 'field-item-inner';
              fieldDiv.innerHTML = `
                <span class="result-label">${field.label || 'N/A'}</span>
                <span class="result-value">${field.value || 'N/A'}</span>
              `;
              fieldsList.appendChild(fieldDiv);
            },
          );
          resultItem.appendChild(fieldsList);
        }
        break;

      case 'table':
        resultItem.classList.add('table-item');
        const tableTitle = document.createElement('h3');
        tableTitle.textContent = element.label || 'Extracted Table';
        resultItem.appendChild(tableTitle);

        if (element.table_data && element.table_data.rows) {
          const table = document.createElement('table');
          const thead = document.createElement('thead');
          const headerRow = document.createElement('tr');

          (element.table_data.headers || []).forEach((headerText: string) => {
            const th = document.createElement('th');
            th.textContent = headerText;
            headerRow.appendChild(th);
          });
          thead.appendChild(headerRow);
          table.appendChild(thead);

          const tbody = document.createElement('tbody');
          element.table_data.rows.forEach((rowData: string[]) => {
            const row = document.createElement('tr');
            rowData.forEach((cellData: string) => {
              const td = document.createElement('td');
              td.textContent = cellData;
              row.appendChild(td);
            });
            tbody.appendChild(row);
          });
          table.appendChild(tbody);
          resultItem.appendChild(table);
        } else {
          resultItem.innerHTML += '<p>Table data is empty or malformed.</p>';
        }
        break;

      default:
        return; // Skip unknown types
    }
    markdownResultsContainer.appendChild(resultItem);
  });
}

function displayJsonResults(data: any) {
  jsonResultsContainer.textContent = JSON.stringify(data, null, 2);
}

function drawBoundingBox(element: any) {
  clearBoundingBoxes();
  const box = element.bounding_box;
  if (!box || !element.page) return;

  const previewElement = document.querySelector(
    `#preview-container [data-page-number='${element.page}']`,
  ) as HTMLElement;

  if (!previewElement) return;

  // Scroll the element into view, centering it vertically.
  previewElement.scrollIntoView({
    behavior: 'smooth',
    block: 'center',
  });

  const boundingBoxDiv = document.createElement('div');
  boundingBoxDiv.className = 'bounding-box';

  if (element.type === 'figure' || element.type === 'logo') {
    boundingBoxDiv.classList.add('bounding-box-visual');
  } else {
    boundingBoxDiv.classList.add('bounding-box-text');
  }

  const displayWidth = previewElement.clientWidth;
  const displayHeight = previewElement.clientHeight;

  const { width: contentWidth, height: contentHeight } =
    pageDimensions[element.page - 1];

  if (!contentWidth || !contentHeight) return;

  const displayAspectRatio = displayWidth / displayHeight;
  const contentAspectRatio = contentWidth / contentHeight;

  let scale: number;
  let offsetX = 0;
  let offsetY = 0;

  if (displayAspectRatio > contentAspectRatio) {
    scale = displayHeight / contentHeight;
    const scaledContentWidth = contentWidth * scale;
    offsetX = (displayWidth - scaledContentWidth) / 2;
  } else {
    scale = displayWidth / contentWidth;
    const scaledContentHeight = contentHeight * scale;
    offsetY = (displayHeight - scaledContentHeight) / 2;
  }

  const boxX = box.x * contentWidth * scale + offsetX;
  const boxY = box.y * contentHeight * scale + offsetY;
  const boxWidth = box.width * contentWidth * scale;
  const boxHeight = box.height * contentHeight * scale;

  const containerRect = previewContainer.getBoundingClientRect();
  const elementRect = previewElement.getBoundingClientRect();

  const relativeTop =
    elementRect.top - containerRect.top + previewContainer.scrollTop;
  const relativeLeft =
    elementRect.left - containerRect.left + previewContainer.scrollLeft;

  boundingBoxDiv.style.left = `${relativeLeft + boxX}px`;
  boundingBoxDiv.style.top = `${relativeTop + boxY}px`;
  boundingBoxDiv.style.width = `${boxWidth}px`;
  boundingBoxDiv.style.height = `${boxHeight}px`;

  previewContainer.appendChild(boundingBoxDiv);
}

function clearBoundingBoxes() {
  const existingBox = document.querySelector('.bounding-box');
  if (existingBox) {
    existingBox.remove();
  }
}

function clearResults() {
  markdownResultsContainer.innerHTML = '';
  jsonResultsContainer.textContent = '';
}

function clearPreview() {
  previewContainer.innerHTML = '';
  fileData = null;
  pageDimensions = [];
  clearBoundingBoxes();
  clearResults();
  setActiveTab('schema');
}

/**
 * Renders a visual representation of the JSON schema in the UI.
 */
function displaySchema() {
  const schemaContainer = document.getElementById('schema-tab');
  schemaContainer.innerHTML = `
    <div class="schema-quick-start">
      <div class="schema-tabs">
        <button class="schema-tab-button active">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"></path></svg>
          Smart Suggestion
        </button>
        <button class="schema-tab-button">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"></path></svg>
          Prompt to Schema
        </button>
      </div>
      <div class="schema-fields">
        <h4>Suggested fields</h4>
        <div class="schema-item">
          <span>extracted_elements</span>
          <span class="schema-type array">Array</span>
        </div>
        <div class="schema-item nested">
          <span>items</span>
          <span class="schema-type object">Object</span>
        </div>
        <div class="schema-item nested-2">
            <span>type</span>
            <span class="schema-type string">String</span>
        </div>
        <div class="schema-item nested-2">
            <span>label</span>
            <span class="schema-type string">String</span>
        </div>
        <div class="schema-item nested-2">
            <span>value</span>
            <span class="schema-type string">String</span>
        </div>
         <div class="schema-item nested-2">
            <span>page</span>
            <span class="schema-type integer">Integer</span>
        </div>
        <div class="schema-item nested-2">
          <span>bounding_box</span>
          <span class="schema-type object">Object</span>
        </div>
        <div class="schema-item nested-2">
          <span>table_data</span>
          <span class="schema-type object">Object</span>
        </div>
        <div class="schema-item nested-2">
          <span>fields</span>
          <span class="schema-type array">Array</span>
        </div>
      </div>
    </div>
  `;
}

// Initial setup
document.addEventListener('DOMContentLoaded', () => {
  displaySchema();
  setActiveTab('schema');
});
